// Synthetic boundary, isolation, evidence and lifecycle tests. No Docker engine, network or real credential is used:
// the Docker CLI is replaced by an in-memory fake and every credential below is a made-up string.
import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigService } from 'hive-core';
import {
  CredentialError, assertLifetime, fingerprintAuthFile, hostAuthPath, readAccessOnly, sameFingerprint, secretScanner,
} from './credentials.mjs';
import { GUARD_EXIT_CODE } from './guard.mjs';
import {
  HIVE_ROLES, HOSTS, PROBE_VARIANTS, REFRESH_SENTINEL, TOOL_FIELD_CONTRACT, authRequest, fieldContractFindings, hiveConfig, hostConfig, nativeToolCall, probeModels,
  requiredLifetimeMs, runArgs, selectionExpectations,
} from './hosts.mjs';
import { payloadFacts, pickSettings } from './observer/index.js';
import {
  STATUS_EXIT, candidateBindingMismatches, caseSummary, checkCriterion, classifyCase, effectiveSettings, failedChecks, finalExit, loadRunRecords,
  hostPreflight, modelEvidenceFailures, paidCase, parseCli, prepareResume, recordReadFailures, rehearsalPathFailures, rehearseInjection,
  modelSelectionFailures, rehearseLifetime, rehearsePaidPath, rehearseSelection, resumePlan, runEndFailure, selectScenarios, selectSharedModel,
  verifyResumeOrigins, wiringFailures,
} from './run.mjs';
import {
  HARNESS_REL, HarnessError, Journal, Resources, artifactFailures, assessContainerIsolation, assessDockerBoundary, build, classifyCorePattern, containerCreateArgs,
  createRunDir, outstandingFromLedger, resolveIdentities, runtimeFailures, verifyArtifact,
} from './runtime.mjs';
import {
  ARTIFACT_CAP, ATTEMPT_LOG_HEADER, FINAL_TEXT_CAP, STOP_INSTRUCTION_CAP, allowlistArgs, attemptCount, clipText, clipToolArgs, codeModeBlocks, codeModeFieldDocs, commandDelivery,
  classifyEditAttempt, containerSecrets, deliveredBodySentence, evidenceLimits, exportDecision, hiveResultFailed, interruptSession, messagePages, mockDecision, preflightReply, readHistories, render, runPrompt, safeName, refusalKind, scenarioOverrides,
  scriptDirective, skillReferencePointers, toolFieldContract, toolOutcome,
} from './fixture.ts';
import {
  credentialFromSnapshot, evidenceScanner, fingerprintWire, scanValue, snapshotAuthFile,
} from './credentials.mjs';
import { GuardState, parseWireFingerprint, sharedClockMs } from './guard.mjs';
import { MESSAGE_ID, exerciseHiveConfig, exerciseHostConfig, exerciseMessageId, exerciseRoutes, nativeStorePath } from './hosts.mjs';
import { exerciseCoreFailures } from './runtime.mjs';
import {
  ACTIONS, CLOCK_MARGIN_MS, DRIVER_FAILURES, DRIVER_REFUSALS, EXIT, INTERRUPT_FLOOR_MS, LIVE_MAX_SECONDS, NO_NEW_WORK_MS, PROJECT_ROOT, QUALIFICATION_CHECKS, acquireRunLock, actionReserveMs,
  admitsAction, admitsNewWork, approvalMessage, catalogProblems, containerCutoffs, descriptorsOf, failureWord, inspectCommand, interpretReply, main as exerciseMain, operationLifetimeMs,
  QUALIFICATION_SUBRUNS, bindCleanup, parseDriverReply, parseExerciseCli, prepareCommand, projectPath, qualificationFailures, registerSubrun, runState, selectionSummary, sharedClockBracket, snapshotInputs, startCommand, stopCommand, turnCommand,
  validateAuthorization, validateInspection, validateOperation, validateRequest,
} from './exercise.mjs';
import {
  approvalObserved, approvalPrecondition, artifactRecord, budget as driverBudget, latestPluginPlanRead, lineDiff, listPrefix, nativeCredentialMatches, normalizeMessage, observeWith,
  observedApprovals, pendingInteractions, quiescence, readHistory, releasedPending, resolveOperation, sessionTree, submit as driverSubmit,
} from './exercise-driver.ts';
import { PLAN_READ_LIMITS, planReadDifferences, readPlan } from './plan-reader.ts';

const SCENARIOS = JSON.parse(readFileSync(join(import.meta.dir, 'scenarios.json'), 'utf8'));
const group = (id: string) => SCENARIOS.groups.find((g: any) => g.id === id);
const FAKE_ACCESS = 'synthetic-access-token-0123456789abcdef';
const FAKE_REFRESH = 'synthetic-refresh-token-fedcba9876543210';
const FAKE_ACCOUNT = 'synthetic-account-42';
const ENGINE = 'engine-under-test';
const MODEL = { id: 'gpt-test', variant: null };

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'ic-harness-test-'));
}

function authFile(entry: any): string {
  const dir = scratch();
  const path = join(dir, 'auth.json');
  writeFileSync(path, JSON.stringify({ anthropic: { type: 'api', key: 'other-provider' }, openai: entry }));
  return path;
}

const COMMON = ['--hosts', 'v1,v2', '--timeout-seconds', '600', '--run-id', 'r1', '--output-root', '/tmp/ic-out'];

describe('CLI contract', () => {
  const code = (argv: string[]) => { try { parseCli(argv); return 'accepted'; } catch (e) { return (e as HarnessError).code; } };
  const SCOPE = ['--candidate-manifest', '/w/manifest.json', '--scenarios', 'interrupted-writer,substantive-handoff'];
  const PAID = ['acceptance', ...SCOPE, '--auth', 'openai-access-only', ...COMMON];
  const REHEARSAL = ['acceptance', ...SCOPE, '--rehearsal', ...COMMON];

  test('wiring is unchanged; acceptance collects the named scenarios with an access-only credential or rehearses them without one', () => {
    expect(parseCli(['wiring', '--candidate-ref', 'HEAD', ...COMMON])).toMatchObject({ phase: 'wiring', paid: false, rehearsal: false, scenarios: [] });
    expect(parseCli(PAID)).toMatchObject({ phase: 'acceptance', paid: true, rehearsal: false, scenarios: ['interrupted-writer', 'substantive-handoff'], candidateManifest: '/w/manifest.json' });
    expect(parseCli(REHEARSAL)).toMatchObject({ phase: 'acceptance', paid: false, rehearsal: true, scenarios: ['interrupted-writer', 'substantive-handoff'] });
    expect(parseCli([...PAID, '--case-limit', '4']).caseLimit).toBe(4);
    const resumed = parseCli([...PAID, '--resume-from', '/r', '--resume-decision', 'continue', '--repurchase', 'v1:milestone-closure']);
    expect(resumed.repurchase).toEqual(['v1:milestone-closure']);
  });

  test('no baseline is accepted or needed: the retired phase and arguments are refused', () => {
    expect(code(['baseline', '--baseline-ref', 'abc', '--rehearsal', ...COMMON])).toBe('phase_required');
    expect(code([...PAID, '--baseline-manifest', '/b'])).toBe('arguments_invalid');
    expect(code([...REHEARSAL, '--baseline-ref', 'x'])).toBe('arguments_invalid');
  });

  test('the scope is explicit, finite and well formed, and only acceptance takes one', () => {
    expect(code(['acceptance', '--candidate-manifest', '/m', '--rehearsal', ...COMMON])).toBe('scenarios_required');
    for (const bad of ['', 'a,,b', 'a,', ',a', 'a,a', 'Upper', 'a b', '../x', 'all,']) {
      expect([bad, code(['acceptance', '--candidate-manifest', '/m', '--scenarios', bad, '--rehearsal', ...COMMON])]).toEqual([bad, 'scenarios_invalid']);
    }
    expect(code(['wiring', '--candidate-ref', 'HEAD', '--scenarios', 'interrupted-writer', ...COMMON])).toBe('ambiguous_subject');
  });

  test('conflicting subject, auth and rehearsal arguments are refused', () => {
    expect(code(['wiring', '--candidate-ref', 'HEAD', '--candidate-manifest', '/m', ...COMMON])).toBe('ambiguous_subject');
    expect(code(['wiring', '--candidate-ref', 'HEAD', '--auth', 'openai-access-only', ...COMMON])).toBe('ambiguous_subject');
    expect(code(['wiring', '--candidate-ref', 'HEAD', '--rehearsal', ...COMMON])).toBe('ambiguous_subject');
    expect(code([...REHEARSAL, '--auth', 'openai-access-only'])).toBe('ambiguous_subject');
    expect(code(['acceptance', ...SCOPE, ...COMMON])).toBe('auth_mode_required');
    expect(code(['acceptance', ...SCOPE, '--auth', 'full', ...COMMON])).toBe('auth_mode_required');
    expect(code(['acceptance', '--scenarios', 'interrupted-writer', '--rehearsal', ...COMMON])).toBe('manifest_required');
    expect(code(['acceptance', ...SCOPE, '--candidate-ref', 'HEAD', '--rehearsal', ...COMMON])).toBe('ambiguous_subject');
    expect(code(['wiring', ...COMMON])).toBe('candidate_ref_required');
  });

  test('deadlines, hosts, run IDs and paid-only options are bounded', () => {
    const short = ['--hosts', 'v1', '--timeout-seconds', '600', '--run-id', 'r', '--output-root', '/o'];
    expect(code(['acceptance', ...SCOPE, '--rehearsal', '--hosts', 'v1', '--timeout-seconds', '601', '--run-id', 'r', '--output-root', '/o'])).toBe('timeout_invalid');
    expect(code(['acceptance', ...SCOPE, '--rehearsal', '--hosts', 'v3', '--timeout-seconds', '600', '--run-id', 'r', '--output-root', '/o'])).toBe('hosts_invalid');
    expect(code(['acceptance', ...SCOPE, '--rehearsal', '--hosts', 'v1', '--timeout-seconds', '600', '--run-id', '../r', '--output-root', '/o'])).toBe('run_id_invalid');
    expect(code(['acceptance', ...SCOPE, '--rehearsal', '--hosts', 'v1', '--timeout-seconds', '600', '--run-id', 'r', '--output-root', 'relative'])).toBe('output_root_invalid');
    expect(code(['wiring', '--candidate-ref', 'HEAD', '--max-model-calls', '12', ...COMMON])).toBe('arguments_invalid');
    expect(code([...PAID, '--resume-from', '/m'])).toBe('resume_requires_decision');
    expect(code([...PAID, '--repurchase', 'v1:g'])).toBe('repurchase_requires_resume');
    expect(code([...PAID, '--case-limit', '0'])).toBe('case_limit_invalid');
    // Rehearsal buys nothing, so batching and resume options have no meaning there.
    for (const option of [['--case-limit', '2'], ['--resume-from', '/r', '--resume-decision', 'x'], ['--repurchase', 'v1:g']]) {
      expect([option[0], code([...REHEARSAL, ...option])]).toEqual([option[0], 'option_requires_paid_phase']);
    }
    expect(code(['wiring', '--candidate-ref', 'HEAD', '--case-limit', '2', ...COMMON])).toBe('option_requires_paid_phase');
    expect(code(['acceptance', ...SCOPE, '--rehearsal', ...short])).toBe('accepted');
  });

  test('never reuses or overwrites an output directory', () => {
    const root = scratch();
    createRunDir(root, 'run-a');
    expect(() => createRunDir(root, 'run-a')).toThrow(HarnessError);
  });

  // The process exit is the only machine-readable result for a caller, so every path ends in one exit code.
  test('the CLI exits 2 for invalid arguments and 1 with a failed manifest when the Docker boundary is refused', () => {
    const runner = join(import.meta.dir, 'run.mjs');
    const bad = spawnSync('node', [runner, 'wiring', '--candidate-ref', 'HEAD'], { encoding: 'utf8' });
    expect(bad.status).toBe(2);
    expect(JSON.parse(bad.stdout.trim()).failure).toBe('hosts_invalid');
    const root = scratch();
    const refused = spawnSync('node', [runner, 'wiring', '--candidate-ref', 'HEAD', '--hosts', 'v1', '--timeout-seconds', '60', '--run-id', 'refused',
      '--output-root', root, '--docker-endpoint', `unix://${join(root, 'missing.sock')}`], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root } });
    expect(refused.status).toBe(1);
    const line = JSON.parse(refused.stdout.trim().split('\n').at(-1)!);
    expect(line.status).toBe('failed');
    expect(line.failures).toContain('docker_boundary_refused');
    expect(JSON.parse(readFileSync(line.manifest, 'utf8')).status).toBe('failed');
    // An acceptance rehearsal records its named scope and says that collection is not a verdict, even when it fails.
    const rehearsal = spawnSync('node', [runner, 'acceptance', '--candidate-manifest', join(root, 'none.json'), '--scenarios', 'interrupted-writer,substantive-handoff', '--rehearsal',
      '--hosts', 'v1', '--timeout-seconds', '60', '--run-id', 'refused-rehearsal', '--output-root', root, '--docker-endpoint', `unix://${join(root, 'missing.sock')}`],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root } });
    expect(rehearsal.status).toBe(1);
    const manifest = JSON.parse(readFileSync(JSON.parse(rehearsal.stdout.trim().split('\n').at(-1)!).manifest, 'utf8'));
    expect(manifest).toMatchObject({
      schema: 'ic-run-manifest/v3', phase: 'acceptance', status: 'failed', paid: false, rehearsalOnly: true, hosts: ['v1'],
      scenarios: ['interrupted-writer', 'substantive-handoff'], interpretation: 'collection_only_not_instruction_acceptance',
    });
  });

  test('cleanup and host-auth problems override every phase status; a checkpoint is distinct from success', () => {
    expect(finalExit({ status: 'passed', cleanupSettled: false, hostAuthChanged: false })).toEqual({ status: 'failed', exitCode: 1 });
    expect(finalExit({ status: 'rehearsal-passed', cleanupSettled: false, hostAuthChanged: false }).exitCode).toBe(1);
    expect(finalExit({ status: 'collected', cleanupSettled: true, hostAuthChanged: true }).exitCode).toBe(1);
    expect(finalExit({ status: 'checkpoint', cleanupSettled: true, hostAuthChanged: false }).exitCode).toBe(3);
    expect(finalExit({ status: 'incomplete', cleanupSettled: true, hostAuthChanged: false }).exitCode).toBe(1);
  });

  test('statuses name collection, never acceptance: the baseline-era verdicts are gone', () => {
    expect(STATUS_EXIT).toEqual({ passed: 0, 'rehearsal-passed': 0, collected: 0, checkpoint: 3, incomplete: 1, failed: 1 });
    for (const retired of ['accepted', 'rejected', 'complete']) expect(STATUS_EXIT).not.toHaveProperty(retired);
  });
});

describe('Docker boundary', () => {
  const info = { ID: ENGINE, OSType: 'linux', KernelVersion: '6.1.0-test', MemoryLimit: true, SwapLimit: true, CgroupVersion: '2', Name: 'docker-desktop', OperatingSystem: 'Docker Desktop' };
  const base = { env: {}, endpoint: 'unix:///var/run/docker.sock', socketIsSocket: true, version: {}, info, localKernel: '6.1.0-test' };

  test('accepts a local unix-socket engine on this kernel', () => {
    expect(assessDockerBoundary(base)).toEqual({ ok: true, failures: [] });
  });

  test('refuses remote, forwarded and uncertain endpoints', () => {
    expect(assessDockerBoundary({ ...base, endpoint: 'tcp://10.0.0.5:2376' }).failures).toContain('endpoint_not_local_unix_socket');
    expect(assessDockerBoundary({ ...base, endpoint: 'ssh://builder@remote' }).failures).toContain('endpoint_not_local_unix_socket');
    expect(assessDockerBoundary({ ...base, socketIsSocket: false }).failures).toContain('endpoint_socket_missing');
    expect(assessDockerBoundary({ ...base, info: { ...info, KernelVersion: '5.15.0-cloud' } }).failures).toContain('engine_kernel_differs_from_local');
    expect(assessDockerBoundary({ ...base, info: { ...info, Name: 'docker-cloud-offload' } }).failures).toContain('engine_remote_marker');
    expect(assessDockerBoundary({ ...base, info: null }).failures).toContain('engine_unreachable');
    expect(assessDockerBoundary({ ...base, info: { ...info, ID: '' } }).failures).toContain('engine_identity_missing');
  });

  test('refuses inherited context, TLS, builder and proxy overrides', () => {
    const env = { DOCKER_CONTEXT: 'remote', DOCKER_TLS_VERIFY: '1', BUILDX_BUILDER: 'cloud', HTTPS_PROXY: 'http://proxy:3128', DOCKER_HOST: 'tcp://x' };
    const { failures } = assessDockerBoundary({ ...base, env });
    for (const name of Object.keys(env)) expect(failures).toContain(`inherited_override:${name}`);
  });

  test('requires engine support for equal memory and swap limits', () => {
    expect(assessDockerBoundary({ ...base, info: { ...info, SwapLimit: false } }).failures).toContain('swap_limit_unsupported');
    expect(assessDockerBoundary({ ...base, info: { ...info, CgroupVersion: '1' } }).failures).toContain('cgroup_v2_required');
  });
});

// A container inspection and in-container probe that satisfy every isolation rule.
function goodInspect(network: string, ceiling = 120, env: string[] = []) {
  return {
    HostConfig: {
      LogConfig: { Type: 'none' }, Memory: 4 * 1024 ** 3, MemorySwap: 4 * 1024 ** 3, Privileged: false, NetworkMode: network, Init: true,
      PortBindings: {}, PublishAllPorts: false, ReadonlyRootfs: true, Ulimits: [{ Name: 'core', Soft: 1, Hard: 1 }], CapDrop: ['ALL'], Binds: null,
    },
    Mounts: [{ Type: 'tmpfs', Destination: '/work' }],
    Config: {
      User: '999:999', Entrypoint: ['node'], Cmd: ['/opt/ic/harness/guard.mjs', 'serve', String(ceiling)],
      Env: ['PATH=/usr/bin', 'HOME=/work/home', 'OPENCODE_SERVER_PASSWORD=local', ...env],
    },
  };
}
const goodProbe = {
  ok: true, uid: 1000, pid1: 'docker-init', guard: { pid: 7, ppid: 1, uid: 999 }, corePattern: '|/wsl-capture-crash %t %E %p %s',
  memoryMax: String(4 * 1024 ** 3), swapMax: '0', coreLimit: '1 1 bytes',
  root: { options: 'ro,relatime' }, work: { fstype: 'tmpfs' }, tmp: { fstype: 'tmpfs' }, otherWritableMounts: [],
};

describe('container isolation and lifetime guard before injection', () => {
  test('create arguments run docker-init with the guard as its only child, under the guard uid, with no persistent state', () => {
    const args = containerCreateArgs({ image: 'sha256:img', labels: ['--label', 'ic.run=r'], network: 'none', password: 'local', ceilingSeconds: 900 });
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toContain('--init');
    expect(value('--user')).toBe('999:999');
    expect(value('--entrypoint')).toBe('node');
    expect(args.slice(-3)).toEqual(['/opt/ic/harness/guard.mjs', 'serve', '900']);
    expect(value('--log-driver')).toBe('none');
    expect(value('--memory')).toBe(value('--memory-swap'));
    expect(value('--ulimit')).toBe('core=1:1');
    expect(args).toContain('--read-only');
    expect(args).not.toContain('infinity');
    for (const forbidden of ['-p', '--publish', '-v', '--volume', '--mount', '--privileged', 'host']) expect(args).not.toContain(forbidden);
    expect(args.filter((a) => a.startsWith('--tmpfs')).length).toBe(2);
  });

  test('passes a correctly isolated, guarded container', () => {
    expect(assessContainerIsolation(goodInspect('none', 120), goodProbe, { network: 'none', ceilingSeconds: 120 })).toEqual({ ok: true, failures: [] });
  });

  test('refuses persistent logging, swap, bind mounts, published ports, extra env and observed swap', () => {
    const bad = goodInspect('host', 120, ['OPENAI_API_KEY=x']) as any;
    bad.HostConfig.LogConfig.Type = 'json-file';
    bad.HostConfig.MemorySwap = -1;
    bad.HostConfig.Binds = ['/home/user:/home/user'];
    bad.HostConfig.PortBindings = { '4096/tcp': [{ HostPort: '4096' }] };
    bad.Mounts.push({ Type: 'bind' });
    const { failures } = assessContainerIsolation(bad, { ...goodProbe, swapMax: 'max', coreLimit: '0 0 bytes' }, { network: 'none', ceilingSeconds: 120 });
    for (const code of ['logging_not_disabled', 'memory_swap_not_equal', 'network_mode_unexpected', 'ports_published', 'non_tmpfs_mount',
      'env_not_allowlisted:OPENAI_API_KEY', 'swap_not_zero_in_cgroup', 'core_limit_not_observed']) {
      expect(failures).toContain(code);
    }
  });

  test('refuses a container without init, guard uid, guard command or an observed guard under PID 1', () => {
    const bad = goodInspect('none', 120) as any;
    bad.HostConfig.Init = false;
    bad.Config.User = '1000:1000';
    bad.Config.Cmd = ['sleep', 'infinity'];
    const probe = { ...goodProbe, pid1: 'sleep', guard: { pid: 9, ppid: 3, uid: 1000 }, uid: 0 };
    const { failures } = assessContainerIsolation(bad, probe, { network: 'none', ceilingSeconds: 120 });
    for (const code of ['init_not_enabled', 'guard_user_unexpected', 'guard_command_unexpected', 'pid1_not_init', 'guard_not_observed', 'agent_uid_unexpected']) {
      expect(failures).toContain(code);
    }
    expect(assessContainerIsolation(goodInspect('none', 300), goodProbe, { network: 'none', ceilingSeconds: 120 }).failures).toContain('guard_command_unexpected');
  });

  test('core dumps: pipe and file patterns are stopped by a 1:1 limit; socket and unknown modes are refused', () => {
    expect(classifyCorePattern('|/wsl-capture-crash %t %E %p %s')).toBe('pipe');
    expect(classifyCorePattern('core')).toBe('file');
    expect(classifyCorePattern('/var/crash/core.%p')).toBe('file');
    expect(classifyCorePattern('@/run/systemd/coredump')).toBe('socket');
    expect(classifyCorePattern('@@/run/coredump.socket')).toBe('socket');
    expect(classifyCorePattern('')).toBe('unknown');
    expect(classifyCorePattern(null)).toBe('unknown');
    const socket = assessContainerIsolation(goodInspect('none'), { ...goodProbe, corePattern: '@/run/sock' }, { network: 'none', ceilingSeconds: 120 });
    expect(socket.failures).toContain('core_pattern_unsupported');
  });
});

describe('access-only credential selection', () => {
  const now = 1_800_000_000_000;
  const required = requiredLifetimeMs('v2', 600_000, 600_000);

  test('exact-host refresh windows come from the qualified versions', () => {
    expect(HOSTS.v1.refreshWindowMs).toBe(0);
    expect(HOSTS.v2.refreshWindowMs).toBe(5 * 60_000);
    expect(requiredLifetimeMs('v2', 600_000, 600_000)).toBe(600_000 + 300_000 + 600_000);
  });

  test('selects only access, expiry and account metadata; the refresh token is not retained', () => {
    const path = authFile({ type: 'oauth', access: FAKE_ACCESS, refresh: FAKE_REFRESH, expires: now + 3_600_000, accountId: FAKE_ACCOUNT });
    const { credential } = readAccessOnly(path, { now, requiredMs: required });
    expect(credential).toEqual({ access: FAKE_ACCESS, expires: now + 3_600_000, accountId: FAKE_ACCOUNT });
    expect(JSON.stringify(credential)).not.toContain(FAKE_REFRESH);
  });

  test('missing, expired, short-lived and unrecognized credentials stop without fallback', () => {
    const code = (path: string) => { try { readAccessOnly(path, { now, requiredMs: required }); return 'accepted'; } catch (e) { return (e as CredentialError).code; } };
    expect(code(join(scratch(), 'absent.json'))).toBe('auth_missing');
    expect(code(authFile({ type: 'oauth', access: FAKE_ACCESS, refresh: FAKE_REFRESH, expires: now - 1 }))).toBe('credential_expired');
    expect(code(authFile({ type: 'oauth', access: FAKE_ACCESS, refresh: FAKE_REFRESH, expires: now + required - 1 }))).toBe('lifetime_insufficient');
    expect(code(authFile({ type: 'oauth', access: FAKE_ACCESS, refresh: FAKE_REFRESH, expires: Math.floor(now / 1000) + 3600 }))).toBe('expires_unit_unrecognized');
    expect(code(authFile({ type: 'api', key: FAKE_ACCESS }))).toBe('openai_entry_not_oauth');
    expect(code(authFile({ type: 'oauth', refresh: FAKE_REFRESH, expires: now + 3_600_000 }))).toBe('access_missing');
    const malformed = join(scratch(), 'auth.json');
    writeFileSync(malformed, '{ not json');
    expect(code(malformed)).toBe('auth_malformed');
    expect(() => assertLifetime({ access: FAKE_ACCESS, expires: now + 1000 }, { now, requiredMs: required })).toThrow(CredentialError);
  });

  test('error messages never carry credential values', () => {
    const path = authFile({ type: 'oauth', access: FAKE_ACCESS, refresh: FAKE_REFRESH, expires: now + 1000 });
    try { readAccessOnly(path, { now, requiredMs: required }); } catch (e) {
      expect(String((e as Error).message)).not.toContain(FAKE_ACCESS);
      expect(JSON.stringify(e)).not.toContain(FAKE_ACCESS);
    }
  });

  test('reading the host store does not change it', () => {
    const path = authFile({ type: 'oauth', access: FAKE_ACCESS, refresh: FAKE_REFRESH, expires: now + 3_600_000 });
    const before = fingerprintAuthFile(path);
    const mtime = statSync(path).mtimeMs;
    readAccessOnly(path, { now, requiredMs: required });
    expect(sameFingerprint(before, fingerprintAuthFile(path))).toBe(true);
    expect(statSync(path).mtimeMs).toBe(mtime);
    writeFileSync(path, '{}');
    expect(sameFingerprint(before, fingerprintAuthFile(path))).toBe(false);
  });

  test('auth path follows XDG data home, then HOME', () => {
    expect(hostAuthPath({ XDG_DATA_HOME: '/x', HOME: '/h' })).toBe('/x/opencode/auth.json');
    expect(hostAuthPath({ HOME: '/h' })).toBe('/h/.local/share/opencode/auth.json');
  });

  test('native injection payloads carry only the unusable refresh sentinel', () => {
    const credential = { access: FAKE_ACCESS, expires: now + 3_600_000, accountId: FAKE_ACCOUNT };
    const v1 = authRequest('v1', credential);
    const v2 = authRequest('v2', credential);
    expect(v1).toMatchObject({ method: 'PUT', path: '/auth/openai', body: { type: 'oauth', refresh: REFRESH_SENTINEL, accountId: FAKE_ACCOUNT } });
    expect(v2).toMatchObject({ method: 'POST', path: '/api/credential', body: { integrationID: 'openai', value: { methodID: 'chatgpt-browser', refresh: REFRESH_SENTINEL, metadata: { accountID: FAKE_ACCOUNT } } } });
    expect(JSON.stringify([v1, v2])).not.toContain(FAKE_REFRESH);
  });

  test('the scanner finds the credential and token-shaped strings', () => {
    const scan = secretScanner({ access: FAKE_ACCESS, expires: now, accountId: FAKE_ACCOUNT });
    expect(scan({ text: `prefix ${FAKE_ACCESS} suffix` })).toBe(true);
    expect(scan(`account ${FAKE_ACCOUNT}`)).toBe(true);
    expect(scan('eyJhbGciOiJIUzI1NiJ9xxxxxxxx.eyJzdWIiOiIxMjM0NTYifQxxxxxx.sig')).toBe(true);
    expect(scan({ text: 'ordinary fixture text' })).toBe(false);
  });
});

// In-memory Docker CLI. Records every argv and stdin; `exec ... run` hangs until the container is killed when asked.
class FakeDocker {
  calls: { args: string[]; input?: string; timeoutMs?: number }[] = [];
  killed = new Set<string>();
  removed = new Set<string>();
  created = new Map<string, { network: string; ceiling: number; nonce: string; kind: string }>();
  armed = new Map<string, number>();
  pending: (() => void)[] = [];
  seq = 0;
  constructor(public behavior: any = {}) {}

  ok(stdout = '') { return { code: 0, stdout, stderr: '', timedOut: false }; }

  nonceOf(args: string[]) {
    const label = args.find((a) => a.startsWith('ic.nonce='));
    return label ? label.slice('ic.nonce='.length) : '';
  }

  async run(args: string[], options: { input?: string; timeoutMs?: number } = {}) {
    this.calls.push({ args, input: options.input, timeoutMs: options.timeoutMs });
    const id = () => (++this.seq).toString(16).padStart(64, '0');
    const [command, sub] = args;
    if (command === 'info') {
      if (this.behavior.engineDown) return { code: 1, stdout: '', stderr: 'Cannot connect', timedOut: false };
      return this.ok(`${this.behavior.otherEngine ? 'another-engine' : ENGINE}\n`);
    }
    if (command === 'network' && sub === 'create') {
      const created = id();
      this.created.set(created, { network: '', ceiling: 0, nonce: this.nonceOf(args), kind: 'network' });
      return this.behavior.loseCreate ? { code: 1, stdout: '', stderr: 'lost', timedOut: true } : this.ok(created);
    }
    if (command === 'network' && sub === 'rm') {
      // As the engine does: a network with an attached container cannot be removed.
      const attached = [...this.created.entries()].some(([cid, c]) => c.kind === 'container' && c.network === args[2] && !this.removed.has(cid));
      if (attached) return { code: 1, stdout: '', stderr: 'network has active endpoints', timedOut: false };
      this.removed.add(args[2]);
      return this.ok();
    }
    if (command === 'ps' || (command === 'network' && sub === 'ls')) {
      if (this.behavior.listFails) return { code: 1, stdout: '', stderr: 'daemon error', timedOut: false };
      const filter = args[args.indexOf('--filter') + 1];
      const kind = command === 'ps' ? 'container' : 'network';
      const matches = [...this.created.entries()].filter(([cid, c]) => c.kind === kind && !(this.removed.has(cid) && !this.behavior.sticky)
        && (filter === `id=${cid}` || filter === `label=ic.nonce=${c.nonce}`)).map(([cid]) => cid);
      return this.ok(matches.join('\n'));
    }
    if (command === 'create') {
      const created = id();
      this.created.set(created, { network: args[args.indexOf('--network') + 1], ceiling: Number(args.at(-1)), nonce: this.nonceOf(args), kind: 'container' });
      return this.ok(created);
    }
    if (command === 'start') return this.ok();
    if (command === 'kill') {
      this.killed.add(args[1]);
      for (const release of this.pending.splice(0)) release();
      return this.ok();
    }
    if (command === 'rm') { this.removed.add(args[args.length - 1]); return this.ok(); }
    if (command === 'inspect') {
      if (args[1] === '--format') return this.ok(JSON.stringify({ Running: false, ExitCode: GUARD_EXIT_CODE, FinishedAt: new Date(Date.now()).toISOString() }));
      const c = this.created.get(args[1]);
      return this.ok(JSON.stringify([goodInspect(c?.network ?? 'none', c?.ceiling ?? 0)]));
    }
    if (command === 'exec') {
      const container = args.find((a) => /^[0-9a-f]{64}$/.test(a))!;
      const user = args[args.indexOf('--user') + 1];
      if (args.includes('/opt/ic/harness/guard.mjs')) {
        const op = args[args.indexOf('/opt/ic/harness/guard.mjs') + 1];
        if (op === 'status') return this.ok(JSON.stringify({ ok: true, armed: this.armed.has(container) }));
        if (user !== '999:999') return this.ok(JSON.stringify({ ok: false, failure: 'guard_unreachable' }));
        if (this.behavior.armFails) return this.ok(JSON.stringify({ ok: false, failure: 'request_invalid' }));
        if (this.armed.has(container)) return this.ok(JSON.stringify({ ok: false, failure: 'already_armed', deadlineAt: this.armed.get(container) }));
        const deadlineAt = Date.now() + Number(args.at(-1)) * 1000;
        this.armed.set(container, deadlineAt);
        return this.ok(JSON.stringify({ ok: true, armed: true, armedAt: Date.now(), deadlineAt, ceilingAt: deadlineAt + 1 }));
      }
      if (args.includes('sleep')) return { code: 137, stdout: '', stderr: '', timedOut: false };
      const fixture = args[args.indexOf('/opt/ic/harness/fixture.ts') + 1];
      if (fixture === 'run' && this.behavior.hangRun) {
        await new Promise<void>((resolve) => this.pending.push(resolve));
        return { code: 137, stdout: '', stderr: '', timedOut: false };
      }
      if (fixture === 'run' && this.behavior.runnerDies) throw new Error('runner interrupted');
      if (fixture === 'run') this.behavior.onRun?.();
      const replies: any = {
        'isolation-probe': goodProbe,
        canary: { ok: true, pid: 12, heartbeat: true, guardSignal: 'EPERM' },
        serve: { ok: true }, setup: { ok: true, steps: [], facts: {} }, stop: { ok: true },
        'inject-auth': this.behavior.injectFails ? { ok: false, status: 400 } : { ok: true, status: 200 },
        run: { ok: true, exit: 0, timedOut: false, asked: null },
        export: this.behavior.exportReply ?? { ok: true, record: this.behavior.record },
        'verify-credential': { ok: true, present: true, sentinelRetained: this.behavior.sentinelRetained ?? true, accessUnchanged: true },
        'secret-probe': { ok: true, count: this.behavior.secretsDiscovered ?? 2 },
        preflight: this.behavior.preflight,
      };
      return this.ok(this.behavior.malformed === fixture ? 'not json' : JSON.stringify(replies[fixture] ?? { ok: false, failure: 'unknown' }));
    }
    return this.ok();
  }

  async json(args: string[]) {
    const result = await this.run(args);
    try { return JSON.parse(result.stdout); } catch { return null; }
  }
}

/** The driver's reply for a run that ended on its own, and the run state the export carries for it. */
const RAN = { exit: 0, asked: null, timedOut: false };
const RAN_PERSISTED = { exit: 0, timedOut: false, asked: null, questionsRejected: 0, durationMs: 1 };
const NO_LIMITS_HIT = { finalTextTruncated: [], toolArgsTruncated: [], artifactsTruncated: [], probesTruncated: [], requestsTruncated: false, historyIncomplete: [], historyFailed: [], callsWithUnknownOutcome: 0 };

/** An exported case record on the frozen model, with observed requests for every responding session. */
function liveRecord({ facts = {}, finalText = '', toolCalls = [] as any[], host = 'v1', run = RAN_PERSISTED as any } = {}) {
  const requests = host === 'v1'
    ? [{ at: 1, host, hook: 'chat.params', sessionID: 's1', agent: 'swarm-orchestrator', providerID: 'openai', modelID: MODEL.id, apiModelID: MODEL.id, settings: { reasoningEffort: 'medium' } }]
    : [
      { at: 1, host, hook: 'model.request', sessionID: 's1', agent: 'swarm-orchestrator', kind: 'primary', providerID: 'openai', modelID: MODEL.id, variant: 'default' },
      { at: 2, host, hook: 'http.request', sessionID: 's1', agent: 'swarm-orchestrator', kind: 'primary', providerID: 'openai', modelID: MODEL.id, variant: 'default', transport: 'http', payload: { model: MODEL.id, settings: { reasoningEffort: 'medium' } } },
    ];
  return {
    schema: 'ic-case-export/v3', facts, probes: {}, artifacts: {}, toolCalls, requests, run,
    limits: evidenceLimits({ ...NO_LIMITS_HIT }),
    sessions: [{ id: 's1', role: 'primary', agent: 'swarm-orchestrator', finalText, assistantMessages: 1, errors: 0, errorNames: [], models: [{ providerID: 'openai', modelID: MODEL.id, variant: host === 'v2' ? 'default' : null }] }],
  };
}
const GOOD_HANDOFF = 'Hive task: 02-validate-parsed-dates\nDestination abc123 on refs/heads/main.\nparseDate must throw RangeError. Check: node --test test/date.test.mjs.\nThe reviewer note is source-only and has not been run.';

function paidContext(docker: FakeDocker, timeoutMs: number, extra: any = {}) {
  const credential = { access: FAKE_ACCESS, expires: Date.now() + 3_600_000, accountId: FAKE_ACCOUNT };
  const outDir = scratch();
  mkdirSync(join(outDir, 'cases'));
  return {
    docker, resources: new Resources(docker as any, join(outDir, 'resources.jsonl'), 'test-run', ENGINE), runtime: { imageId: 'sha256:image' },
    scenarios: SCENARIOS, runId: 'test-run', timeoutMs, secretBearing: true, credential, scan: secretScanner(credential), model: MODEL,
    journal: Journal.create(join(outDir, 'records')), outDir, auth: null, ...extra,
  };
}

const callIndex = (docker: FakeDocker, predicate: (args: string[]) => boolean) => docker.calls.findIndex((c) => predicate(c.args));

describe('paid case lifecycle', () => {
  test('the deadline kills the whole container, which stops every process inside it, and cleans up by exact ID', async () => {
    const docker = new FakeDocker({ hangRun: true });
    const result = await paidCase(paidContext(docker, 200), 'v1', group('substantive-handoff'));
    expect(result.outcome).toBe('timeout');
    const containerId = [...docker.created.entries()].find(([, c]) => c.kind === 'container')![0];
    expect(docker.killed.has(containerId)).toBe(true);
    expect(docker.removed.has(containerId)).toBe(true);
    expect(docker.calls.filter((c) => c.args[0] === 'network' && c.args[1] === 'rm').every((c) => /^[0-9a-f]{64}$/.test(c.args[2]))).toBe(true);
  });

  test('the guard acknowledges a one-shot deadline before the credential is injected, only on stdin', async () => {
    const docker = new FakeDocker({ record: liveRecord({ facts: { targetCommit: 'abc123' }, finalText: GOOD_HANDOFF, host: 'v2' }) });
    const ctx = paidContext(docker, 60_000);
    const result = await paidCase(ctx, 'v2', group('substantive-handoff'));
    expect(result.outcome).toBe('collected');
    expect(result).not.toHaveProperty('grade');
    expect(result.fixtureFailed).toEqual([]);
    const arm = callIndex(docker, (a) => a.includes('arm') && a.includes('/opt/ic/harness/guard.mjs'));
    const inject = callIndex(docker, (a) => a.includes('inject-auth'));
    expect(arm).toBeGreaterThan(-1);
    expect(arm).toBeLessThan(inject);
    expect(docker.calls[arm].args).toEqual(expect.arrayContaining(['--user', '999:999', 'arm', '60']));
    for (const call of docker.calls) expect(call.args.join(' ')).not.toContain(FAKE_ACCESS);
    const carrying = docker.calls.filter((c) => c.input?.includes(FAKE_ACCESS));
    expect(carrying.length).toBe(1);
    expect(carrying[0].args.slice(0, 4)).toEqual(['exec', '-i', '--user', '1000:1000']);
    expect(carrying[0].input).not.toContain(FAKE_REFRESH);
    expect(ctx.journal.read('case.v2.substantive-handoff.started')!.value.guardDeadlineAt).toBeGreaterThan(0);
    expect(ctx.journal.read('case.v2.substantive-handoff.outcome')!.value.outcome).toBe('collected');
  });

  test('a guard that does not acknowledge the arm stops the case before any injection', async () => {
    const docker = new FakeDocker({ armFails: true, record: liveRecord() });
    await expect(paidCase(paidContext(docker, 60_000), 'v1', group('substantive-handoff'))).rejects.toMatchObject({ code: 'guard_arm_failed' });
    expect(docker.calls.some((c) => c.args.includes('inject-auth'))).toBe(false);
  });

  test('a failure before the prompt leaves the case never started, so a resume may run it without a repurchase', async () => {
    const docker = new FakeDocker({ injectFails: true });
    const ctx = paidContext(docker, 60_000);
    await expect(paidCase(ctx, 'v1', group('substantive-handoff'))).rejects.toMatchObject({ code: 'auth_injection_failed' });
    expect(ctx.journal.names()).toEqual([]);
  });

  test('a failure after the prompt was sent records a stopped outcome, never a collected one', async () => {
    const docker = new FakeDocker({ runnerDies: true });
    const ctx = paidContext(docker, 60_000);
    await expect(paidCase(ctx, 'v1', group('substantive-handoff'))).rejects.toThrow('runner interrupted');
    expect(ctx.journal.read('case.v1.substantive-handoff.started')).not.toBeNull();
    expect(ctx.journal.read('case.v1.substantive-handoff.outcome')!.value.outcome).toBe('stopped');
  });

  test('a contaminated export stops the run and is not returned; the container is still removed', async () => {
    const docker = new FakeDocker({ record: liveRecord({ finalText: `leaked ${FAKE_ACCESS}` }) });
    await expect(paidCase(paidContext(docker, 60_000), 'v1', group('substantive-handoff'))).rejects.toMatchObject({ code: 'export_contaminated' });
    expect(docker.removed.size).toBeGreaterThanOrEqual(2);
  });

  test('an export the container could not scan exactly stops the run with its fixed code and no record', async () => {
    const docker = new FakeDocker({ exportReply: { ok: false, failure: 'secret_scan_unavailable', host: 'v1', scenario: 'substantive-handoff' } });
    const ctx = paidContext(docker, 60_000);
    await expect(paidCase(ctx, 'v1', group('substantive-handoff'))).rejects.toMatchObject({ code: 'secret_scan_unavailable' });
    expect(ctx.journal.read('case.v1.substantive-handoff.outcome')!.value).toMatchObject({ outcome: 'stopped', code: 'secret_scan_unavailable' });
    expect(docker.removed.size).toBeGreaterThanOrEqual(2);
  });

  test('a container credential that lost its refresh sentinel is a security stop', async () => {
    const docker = new FakeDocker({ record: liveRecord({ finalText: GOOD_HANDOFF }), sentinelRetained: false });
    await expect(paidCase(paidContext(docker, 60_000), 'v1', group('substantive-handoff'))).rejects.toMatchObject({ code: 'container_credential_unconfirmed' });
  });

  test('malformed fixture output is an infrastructure failure, not a collected outcome', async () => {
    const docker = new FakeDocker({ malformed: 'serve' });
    await expect(paidCase(paidContext(docker, 60_000), 'v1', group('substantive-handoff'))).rejects.toMatchObject({ code: 'fixture_output_malformed' });
  });

  test('a malformed export after a completed run is invalid evidence, never a pass', async () => {
    const docker = new FakeDocker({ malformed: 'export' });
    const result = await paidCase(paidContext(docker, 60_000), 'v1', group('substantive-handoff'));
    expect(result.outcome).toBe('evidence_invalid');
  });

  test('an expired credential is refused before injection', async () => {
    const docker = new FakeDocker({ record: liveRecord({ finalText: GOOD_HANDOFF }) });
    const ctx = paidContext(docker, 60_000);
    ctx.credential.expires = Date.now() + 1000;
    await expect(paidCase(ctx, 'v1', group('substantive-handoff'))).rejects.toMatchObject({ code: 'lifetime_insufficient' });
    expect(docker.calls.some((c) => c.args.includes('inject-auth'))).toBe(false);
  });

  test('host auth is checked before injection and after each case; only unchanged booleans are recorded', async () => {
    const path = authFile({ type: 'oauth', access: FAKE_ACCESS, refresh: FAKE_REFRESH, expires: Date.now() + 3_600_000 });
    const auth = { path, atAcquisition: fingerprintAuthFile(path), changed: false };
    const changing = new FakeDocker({ record: liveRecord({ facts: { targetCommit: 'abc123' }, finalText: GOOD_HANDOFF }), onRun: () => writeFileSync(path, '{"openai":{}}') });
    const result = await paidCase(paidContext(changing, 60_000, { auth }), 'v1', group('substantive-handoff'));
    expect(result.hostAuthUnchangedAfter).toBe(false);
    expect(auth.changed).toBe(true);
    // A later case does not start once the store has changed; attribution stays unresolved and nothing is restored.
    const next = new FakeDocker({ record: liveRecord() });
    await expect(paidCase(paidContext(next, 60_000, { auth }), 'v1', group('substantive-handoff'))).rejects.toMatchObject({ code: 'host_auth_changed' });
    expect(next.calls.some((c) => c.args.includes('inject-auth'))).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('{"openai":{}}');
    expect(JSON.stringify(result.effectiveSettings)).not.toContain(FAKE_ACCESS);
  });
});

describe('credential-free rehearsals', () => {
  test('injection rehearsal uses a made-up credential, no network, a guard arm and stdin only', async () => {
    const docker = new FakeDocker();
    const ctx = { ...paidContext(docker, 60_000), credential: undefined, secretBearing: false };
    const result = await rehearseInjection(ctx, 'v2');
    expect(result.ok).toBe(true);
    const create = docker.calls.find((c) => c.args[0] === 'create')!;
    expect(create.args[create.args.indexOf('--network') + 1]).toBe('none');
    const inject = docker.calls.find((c) => c.args.includes('inject-auth'))!;
    expect(inject.input).toContain('ic-synthetic-access-');
    expect(inject.args.join(' ')).not.toContain('ic-synthetic-access-');
    expect(callIndex(docker, (a) => a.includes('arm'))).toBeLessThan(callIndex(docker, (a) => a.includes('inject-auth')));
  });

  test('the paid-path dry run uses no network, a made-up credential and the normal deadline and cleanup', async () => {
    const docker = new FakeDocker({ hangRun: true });
    const ctx = { ...paidContext(docker, 60_000), credential: undefined, secretBearing: false };
    const result = await rehearsePaidPath(ctx, 'v1', group('substantive-handoff'), 200);
    expect(result).toMatchObject({ outcome: 'timeout', ok: true });
    expect(docker.calls.some((c) => c.args[0] === 'network' && c.args[1] === 'create')).toBe(false);
    expect(docker.calls.find((c) => c.args.includes('inject-auth'))!.input).toContain('ic-synthetic-access-');
  });

  test('fails when the export scan could not see the stored value', async () => {
    const docker = new FakeDocker({ secretsDiscovered: 0 });
    expect((await rehearseInjection({ ...paidContext(docker, 60_000), credential: undefined }, 'v1')).ok).toBe(false);
  });

  test('lifetime rehearsal: agent uid cannot arm or signal the guard, the arm is one-shot, and the container stops by itself', async () => {
    const docker = new FakeDocker();
    const result = await rehearseLifetime({ ...paidContext(docker, 60_000), credential: undefined }, { armSeconds: 0, graceMs: 2000, pollMs: 1 });
    expect(result).toMatchObject({ canaryHeartbeat: true, guardSignalRefused: true, agentArmRefused: true, secondArmRefused: true, stoppedWithoutHostKill: true, exitCode: GUARD_EXIT_CODE, ok: true });
    // The runner sends no kill to the container under test.
    expect(docker.killed.size).toBe(1);
    expect(docker.calls.filter((c) => c.args[0] === 'kill').length).toBe(1);
  });
});

describe('owned resources', () => {
  test('a lost create response is settled by its unique nonce label and still cleaned up by ID', async () => {
    const docker = new FakeDocker({ loseCreate: true });
    const ledger = join(scratch(), 'resources.jsonl');
    const resources = new Resources(docker as any, ledger, 'run', ENGINE);
    await expect(resources.create('network', (labels: string[]) => ['network', 'create', ...labels, 'n'])).rejects.toMatchObject({ code: 'create_failed' });
    const lookup = docker.calls.find((c) => c.args[0] === 'network' && c.args[1] === 'ls')!;
    expect(lookup.args.join(' ')).toMatch(/label=ic\.nonce=[0-9a-f-]{36}/);
    expect(resources.live.size).toBe(1);
    expect((await resources.removeAll()).every((r: any) => r.state === 'absent')).toBe(true);
    expect(resources.settled).toBe(true);
    expect(readFileSync(ledger, 'utf8')).toContain('"recovered":true');
  });

  test('a lost create that cannot be looked up stays unknown and blocks settlement', async () => {
    const docker = new FakeDocker({ loseCreate: true, listFails: true });
    const resources = new Resources(docker as any, join(scratch(), 'r.jsonl'), 'run', ENGINE);
    await expect(resources.create('network', (labels: string[]) => ['network', 'create', ...labels, 'n'])).rejects.toMatchObject({ code: 'create_unknown' });
    const results = await resources.removeAll();
    expect(results).toEqual([{ nonce: expect.any(String), state: 'unknown' }]);
    expect(resources.settled).toBe(false);
  });

  test('a Docker error after removal is unknown, not proof of absence; the exact ID is retained', async () => {
    const docker = new FakeDocker();
    const resources = new Resources(docker as any, join(scratch(), 'r.jsonl'), 'run', ENGINE);
    const id = await resources.create('container', (labels: string[]) => ['create', ...labels, '--network', 'none', 'img', '120']);
    docker.behavior.listFails = true;
    await expect(resources.remove(id)).rejects.toMatchObject({ code: 'cleanup_unknown' });
    expect(resources.live.has(id)).toBe(true);
    docker.behavior = { engineDown: true };
    expect(await resources.observe('container', id)).toBe('unknown');
    docker.behavior = { otherEngine: true };
    expect(await resources.observe('container', id)).toBe('unknown');
    docker.behavior = {};
    expect(await resources.removeAll()).toEqual([{ id, state: 'absent' }]);
  });

  test('a resource still listed after removal is reported present and stops the run', async () => {
    const docker = new FakeDocker({ sticky: true });
    const resources = new Resources(docker as any, join(scratch(), 'r.jsonl'), 'run', ENGINE);
    const id = await resources.create('container', (labels: string[]) => ['create', ...labels, '--network', 'none', 'img', '120']);
    await expect(resources.remove(id)).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
    expect(await resources.removeAll()).toEqual([{ id, state: 'present' }]);
    expect(resources.counts.stillPresent).toBe(1);
  });

  test('only resources this run created can be removed', async () => {
    const resources = new Resources(new FakeDocker() as any, join(scratch(), 'r.jsonl'), 'run', ENGINE);
    await expect(resources.remove('a'.repeat(64))).rejects.toMatchObject({ code: 'resource_not_owned' });
  });
});

describe('immutable records and resume', () => {
  test('records are published once and never overwritten', () => {
    const journal = Journal.create(join(scratch(), 'records'));
    journal.write('prepared', { a: 1 });
    expect(() => journal.write('prepared', { a: 2 })).toThrow(HarnessError);
    expect(journal.read('prepared')!.value).toEqual({ a: 1 });
    expect(readdirSync(journal.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  const identity = {
    phase: 'acceptance', harness: { commit: 'h', tree: 't', scenariosSha256: 's' }, subject: { commit: 'c' }, artifact: { sha256: 'a', file: '/a' },
    runtime: { imageId: 'sha256:i' }, runtimeIdentity: { r: 1 }, isolation: { x: 1 }, timeoutSeconds: 600, hosts: ['v1'], scenarios: ['g1', 'g2', 'g3', 'g4'],
    candidateWiring: { manifest: '/w/manifest.json', sha256: 'w' }, docker: { engineId: ENGINE },
  };
  const groups = [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }, { id: 'g4' }];
  const expected = {
    phase: 'acceptance', harness: identity.harness, subject: 'c', artifact: 'a', runtimeImageId: 'sha256:i', runtimeIdentity: { r: 1 }, isolation: { x: 1 },
    timeoutSeconds: 600, hosts: ['v1'], scenarios: ['g1', 'g2', 'g3', 'g4'], candidateWiringSha256: 'w', engineId: ENGINE,
  };

  function sourceRun() {
    const runDir = scratch();
    const journal = Journal.create(join(runDir, 'records'));
    journal.write('prepared', identity);
    journal.write('model', { model: MODEL });
    journal.write('preflight.v1.started', {});
    journal.write('preflight.v1.outcome', { host: 'v1', ok: true });
    const caseFile = join(runDir, 'g1.json');
    writeFileSync(caseFile, '{"graded":true}');
    const sha = new Bun.CryptoHasher('sha256').update('{"graded":true}').digest('hex');
    journal.write('case.v1.g1.started', {});
    journal.write('case.v1.g1.outcome', { host: 'v1', group: 'g1', outcome: 'collected', file: caseFile, sha256: sha });
    journal.write('case.v1.g2.started', {});
    journal.write('case.v1.g3.started', {});
    journal.write('case.v1.g3.outcome', { host: 'v1', group: 'g3', outcome: 'timeout' });
    return { runDir, caseFile };
  }

  test('a resume reuses collected records, keeps started-without-outcome as unknown and runs only never-started cases', () => {
    const { runDir } = sourceRun();
    const { plan, model } = resumePlan(loadRunRecords(runDir), { expected, groups, hosts: ['v1'], repurchase: [] });
    expect(model.model).toEqual(MODEL);
    expect(plan['v1:preflight'].action).toBe('reuse');
    expect(plan['v1:g1'].action).toBe('reuse');
    expect(plan['v1:g2']).toMatchObject({ action: 'carry', summary: { outcome: 'unknown' } });
    expect(plan['v1:g3']).toMatchObject({ action: 'carry', summary: { outcome: 'timeout' } });
    expect(plan['v1:g4'].action).toBe('run');
    expect(() => verifyResumeOrigins(plan)).not.toThrow();
  });

  test('only an explicit repurchase runs an unresolved paid case again, and never a valid one', () => {
    const { runDir } = sourceRun();
    const source = loadRunRecords(runDir);
    expect(resumePlan(source, { expected, groups, hosts: ['v1'], repurchase: ['v1:g2'] }).plan['v1:g2'].action).toBe('run');
    expect(() => resumePlan(source, { expected, groups, hosts: ['v1'], repurchase: ['v1:g1'] })).toThrow('repurchase_not_unresolved');
    expect(() => resumePlan(source, { expected, groups, hosts: ['v1'], repurchase: ['v2:g1'] })).toThrow('repurchase_unknown_item');
  });

  test('a resume with any different input identity or scope is refused before credentials', () => {
    const { runDir } = sourceRun();
    const source = loadRunRecords(runDir);
    for (const [key, value] of [['artifact', 'other'], ['runtimeImageId', 'sha256:j'], ['isolation', { x: 2 }], ['timeoutSeconds', 300], ['engineId', 'e2'], ['harness', { ...identity.harness, scenariosSha256: 'z' }],
      // A resume never widens, narrows or reorders-by-swap the named scope, and stays bound to the same wiring manifest.
      ['scenarios', ['g1', 'g2']], ['scenarios', ['g1', 'g2', 'g3', 'g4', 'g5']], ['candidateWiringSha256', 'other'], ['phase', 'baseline']] as const) {
      expect(() => resumePlan(source, { expected: { ...expected, [key]: value }, groups, hosts: ['v1'], repurchase: [] })).toThrow('resume_inputs_differ');
    }
  });

  test('a changed reused case file is refused', () => {
    const { runDir, caseFile } = sourceRun();
    const { plan } = resumePlan(loadRunRecords(runDir), { expected, groups, hosts: ['v1'], repurchase: [] });
    writeFileSync(caseFile, '{"graded":false}');
    expect(() => verifyResumeOrigins(plan)).toThrow('resume_case_file_changed');
  });

  test('an earlier graded outcome is not a collected record: it is carried as unresolved, never reused as a pass', () => {
    const runDir = earlierRun((journal) => {
      journal.write('case.v1.g1.started', {});
      journal.write('case.v1.g1.outcome', { host: 'v1', group: 'g1', outcome: 'graded' });
    });
    expect(planFrom(runDir)['v1:g1']).toMatchObject({ action: 'carry', summary: { outcome: 'graded' } });
  });

  test('a source run without a prepared record cannot be resumed', () => {
    const runDir = scratch();
    Journal.create(join(runDir, 'records'));
    expect(() => loadRunRecords(runDir)).toThrow('resume_source_unprepared');
  });

  // ---- Resume lifecycle: prior resources settled and history inherited before any credential or paid item.
  const HEX = (char: string) => char.repeat(64);

  function writeLedger(runDir: string, events: any[]) {
    writeFileSync(join(runDir, 'resources.jsonl'), events.map((e) => JSON.stringify({ at: 'now', ...e })).join('\n') + (events.length ? '\n' : ''));
  }

  /** A finished earlier run with a prepared record, an empty ledger and whatever records the test writes. */
  function earlierRun(write: (journal: Journal, runDir: string) => void = () => {}, extra: any = {}) {
    const runDir = scratch();
    const journal = Journal.create(join(runDir, 'records'));
    journal.write('prepared', { ...identity, ...extra });
    writeFileSync(join(runDir, 'resources.jsonl'), '');
    write(journal, runDir);
    return runDir;
  }

  function gradedCase(journal: Journal, runDir: string, id: string) {
    const file = join(runDir, `${id}.json`);
    writeFileSync(file, `{"case":"${id}"}`);
    const sha256 = new Bun.CryptoHasher('sha256').update(`{"case":"${id}"}`).digest('hex');
    journal.write(`case.v1.${id}.started`, {});
    journal.write(`case.v1.${id}.outcome`, { host: 'v1', group: id, outcome: 'collected', file, sha256 });
  }

  /** The same call the runner makes after resume validation and before it reads a credential. */
  function startResume(sourceDir: string, { docker = new FakeDocker(), repurchase = [] as string[], decision = 'continue' } = {}) {
    const runDir = scratch();
    const journal = Journal.create(join(runDir, 'records'));
    writeFileSync(join(runDir, 'resources.jsonl'), '');
    const resources = new Resources(docker as any, join(runDir, 'resources.jsonl'), 'resume-run', ENGINE);
    const prepared = { ...identity, resumedFrom: { runDir: sourceDir, decision } };
    const go = () => prepareResume({ source: loadRunRecords(sourceDir), expected, groups, hosts: ['v1'], repurchase, decision, resources, journal, prepared });
    return { runDir, journal, resources, docker, go };
  }

  const resumeFrom = async (sourceDir: string, options?: Parameters<typeof startResume>[1]) => {
    const started = startResume(sourceDir, options);
    return { ...started, resumed: await started.go() };
  };
  const planFrom = (sourceDir: string, repurchase: string[] = []) => resumePlan(loadRunRecords(sourceDir), { expected, groups, hosts: ['v1'], repurchase }).plan;

  test('a resume settles the earlier run\'s outstanding containers and lost creates by exact ID before it publishes anything', async () => {
    const runDir = earlierRun();
    const [leftover, lost, done] = [HEX('a'), HEX('b'), HEX('c')];
    writeLedger(runDir, [
      { event: 'create_requested', kind: 'container', nonce: 'n1' }, { event: 'created', kind: 'container', nonce: 'n1', id: leftover },
      { event: 'create_requested', kind: 'network', nonce: 'n2' },
      { event: 'create_requested', kind: 'container', nonce: 'n3' }, { event: 'created', kind: 'container', nonce: 'n3', id: done }, { event: 'removed', kind: 'container', id: done },
      { event: 'image_retained', kind: 'image', id: 'sha256:retained' },
    ]);
    const docker = new FakeDocker();
    docker.created.set(leftover, { network: 'x', ceiling: 0, nonce: 'n1', kind: 'container' });
    docker.created.set(lost, { network: '', ceiling: 0, nonce: 'n2', kind: 'network' });
    const run = await resumeFrom(runDir, { docker });
    expect(docker.killed.has(leftover)).toBe(true);
    expect(docker.removed.has(leftover)).toBe(true);
    expect(docker.removed.has(lost)).toBe(true);
    expect(docker.calls.some((c) => c.args.includes(done))).toBe(false);
    expect(run.resources.settled).toBe(true);
    expect(run.resumed.priorResources).toMatchObject({ outstandingIds: 1, outstandingNonces: 1, removed: 2 });
    const ledger = readFileSync(join(run.runDir, 'resources.jsonl'), 'utf8');
    expect(ledger).toContain('"event":"adopted"');
    expect(ledger.match(/"event":"removed"/g)?.length).toBe(2);
    expect(run.journal.names()).toEqual(['inherited', 'prepared']);
  });

  test('an interrupted networked case resumes on the first try: the ledger lists the network first, the container is removed before it', async () => {
    const runDir = earlierRun();
    const [network, container] = [HEX('7'), HEX('8')];
    // The order paidCase writes: network created, then the container attached to it.
    writeLedger(runDir, [
      { event: 'create_requested', kind: 'network', nonce: 'n1' }, { event: 'created', kind: 'network', nonce: 'n1', id: network },
      { event: 'create_requested', kind: 'container', nonce: 'n2' }, { event: 'created', kind: 'container', nonce: 'n2', id: container },
    ]);
    const docker = new FakeDocker();
    docker.created.set(network, { network: '', ceiling: 0, nonce: 'n1', kind: 'network' });
    docker.created.set(container, { network, ceiling: 0, nonce: 'n2', kind: 'container' });
    const run = await resumeFrom(runDir, { docker });
    const order = docker.calls.filter((c) => c.args[0] === 'rm' || (c.args[0] === 'network' && c.args[1] === 'rm')).map((c) => c.args.at(-1));
    expect(order).toEqual([container, network]);
    expect(run.resumed.priorResources).toMatchObject({ outstandingIds: 2, removed: 2 });
    expect(run.resources.settled).toBe(true);
    expect(run.journal.names()).toEqual(['inherited', 'prepared']);
    // The same lost-create path: the container is recovered by nonce after the network is already listed.
    const lostRun = earlierRun();
    writeLedger(lostRun, [{ event: 'created', kind: 'network', nonce: 'n1', id: network }, { event: 'create_requested', kind: 'container', nonce: 'n2' }]);
    const lostDocker = new FakeDocker();
    lostDocker.created.set(network, { network: '', ceiling: 0, nonce: 'n1', kind: 'network' });
    lostDocker.created.set(container, { network, ceiling: 0, nonce: 'n2', kind: 'container' });
    expect((await resumeFrom(lostRun, { docker: lostDocker })).resources.settled).toBe(true);
  });

  test('the engine double refuses to remove a network while a container is attached', async () => {
    const docker = new FakeDocker();
    const network = (await docker.run(['network', 'create', '--label', 'ic.nonce=n1'])).stdout;
    const container = (await docker.run(['create', '--network', network, '--label', 'ic.nonce=n2', '60'])).stdout;
    expect((await docker.run(['network', 'rm', network])).code).toBe(1);
    expect(docker.removed.has(network)).toBe(false);
    await docker.run(['rm', '-f', '-v', container]);
    expect((await docker.run(['network', 'rm', network])).code).toBe(0);
  });

  test('a resource that cannot be confirmed gone blocks the resume with nothing inherited or prepared, and no untracked Docker command', async () => {
    const leftover = HEX('d');
    const outstanding = [{ event: 'create_requested', kind: 'container', nonce: 'n1' }, { event: 'created', kind: 'container', nonce: 'n1', id: leftover }];
    for (const behavior of [{ listFails: true }, { engineDown: true }, { otherEngine: true }]) {
      const runDir = earlierRun();
      writeLedger(runDir, outstanding);
      const docker = new FakeDocker(behavior);
      docker.created.set(leftover, { network: 'x', ceiling: 0, nonce: 'n1', kind: 'container' });
      const started = startResume(runDir, { docker });
      await expect(started.go()).rejects.toMatchObject({ code: 'cleanup_unknown' });
      expect(started.journal.names()).toEqual([]);
      expect(started.resources.settled).toBe(false);
      expect(started.resources.live.has(leftover)).toBe(true);
      // Only exact-ID commands through the bound engine: no `docker ps`/`rm` by name or label sweep.
      expect(docker.calls.every((c) => ['info', 'kill', 'rm', 'ps'].includes(c.args[0]))).toBe(true);
    }
    const lostRun = earlierRun();
    writeLedger(lostRun, [{ event: 'create_requested', kind: 'container', nonce: 'n9' }]);
    const lost = startResume(lostRun, { docker: new FakeDocker({ listFails: true }) });
    await expect(lost.go()).rejects.toMatchObject({ code: 'prior_resources_unsettled' });
    expect(lost.journal.names()).toEqual([]);
  });

  test('a ledger that is missing, unreadable or says everything was removed is handled without guessing', async () => {
    const noLedger = earlierRun();
    writeFileSync(join(noLedger, 'resources.jsonl'), 'not json\n');
    await expect(startResume(noLedger).go()).rejects.toMatchObject({ code: 'ledger_unreadable' });
    const missing = sourceRun().runDir;
    await expect(startResume(missing).go()).rejects.toMatchObject({ code: 'prior_ledger_missing' });
    const settled = earlierRun();
    writeLedger(settled, [{ event: 'create_requested', kind: 'container', nonce: 'n1' }, { event: 'created', kind: 'container', nonce: 'n1', id: HEX('e') }, { event: 'removed', kind: 'container', id: HEX('e') }]);
    const run = await resumeFrom(settled);
    expect(run.docker.calls).toEqual([]);
    expect(run.resumed.priorResources).toMatchObject({ outstandingIds: 0, outstandingNonces: 0, removed: 0 });
  });

  test('the ledger reader keeps everything not confirmed removed and ignores images', () => {
    const lines = [
      { event: 'create_requested', kind: 'container', nonce: 'n1' }, { event: 'created', kind: 'container', nonce: 'n1', id: HEX('1') }, { event: 'removed', kind: 'container', id: HEX('1') },
      { event: 'create_requested', kind: 'network', nonce: 'n2' },
      { event: 'create_requested', kind: 'container', nonce: 'n3' }, { event: 'create_absent', kind: 'container', nonce: 'n3' },
      { event: 'create_requested', kind: 'container', nonce: 'n4' }, { event: 'create_unknown', kind: 'container', nonce: 'n4' },
      { event: 'created', kind: 'container', nonce: 'n5', id: HEX('5') }, { event: 'remove_unknown', kind: 'container', id: HEX('5') },
      { event: 'adopted', kind: 'network', id: HEX('6') },
      { event: 'image_retained', kind: 'image', id: 'sha256:x' },
    ].map((e) => JSON.stringify(e)).join('\n');
    const { ids, nonces } = outstandingFromLedger(lines);
    expect([...ids.keys()].sort()).toEqual([HEX('5'), HEX('6')]);
    expect([...nonces.keys()].sort()).toEqual(['n2', 'n4']);
    expect(() => outstandingFromLedger('{"event":"created","kind":"container","id":"short"}')).toThrow('ledger_unreadable');
    expect(() => outstandingFromLedger('{"event":"create_requested","kind":"image","nonce":"n"}')).toThrow('ledger_unreadable');
  });

  test('unknown preflight -> a resume that stopped incomplete -> another resume still carries it and runs nothing', async () => {
    const a = earlierRun((journal, runDir) => {
      journal.write('model', { model: MODEL, catalogs: {} });
      journal.write('preflight.v1.started', {});
      gradedCase(journal, runDir, 'g1');
      journal.write('case.v1.g2.started', {});
    });
    const b = await resumeFrom(a);
    expect(b.resumed.plan.plan['v1:preflight'].action).toBe('carry');
    // The stopped resume left only `inherited` and `prepared`; the next resume must still see A's history through them.
    const c = planFrom(b.runDir);
    expect(c['v1:preflight']).toMatchObject({ action: 'carry', summary: { ok: false, outcome: 'unknown' }, origin: { runDir: a, record: 'preflight.v1.started' } });
    expect(c['v1:g1']).toMatchObject({ action: 'reuse', origin: { runDir: a, record: 'case.v1.g1.outcome' } });
    expect(c['v1:g2']).toMatchObject({ action: 'carry', summary: { outcome: 'unknown' }, origin: { runDir: a } });
    expect(c['v1:g3'].action).toBe('run');
    expect(() => verifyResumeOrigins(c)).not.toThrow();
    // Only an explicit repurchase of the unresolved preflight releases it.
    expect(planFrom(b.runDir, ['v1:preflight'])['v1:preflight'].action).toBe('run');
    // And it survives a third and fourth link of the chain.
    const d = await resumeFrom(b.runDir);
    expect(planFrom(d.runDir)['v1:preflight']).toMatchObject({ action: 'carry', origin: { runDir: a } });
  });

  test('a completed case and the frozen model survive a resume that failed on authentication', async () => {
    const a = earlierRun((journal, runDir) => {
      journal.write('model', { model: MODEL, catalogs: { v1: ['gpt-test'] } });
      journal.write('preflight.v1.started', {});
      journal.write('preflight.v1.outcome', { host: 'v1', ok: true });
      gradedCase(journal, runDir, 'g1');
    });
    const b = await resumeFrom(a);
    // B stops at credential acquisition: nothing beyond `inherited` and `prepared` exists in its records.
    expect(b.journal.names()).toEqual(['inherited', 'prepared']);
    const source = loadRunRecords(b.runDir);
    const plan = resumePlan(source, { expected, groups, hosts: ['v1'], repurchase: [] });
    expect(plan.plan['v1:g1']).toMatchObject({ action: 'reuse', origin: { runDir: a, record: 'case.v1.g1.outcome' } });
    expect(plan.plan['v1:preflight'].action).toBe('reuse');
    expect(plan.model).toMatchObject({ model: MODEL });
    expect(() => verifyResumeOrigins(plan.plan)).not.toThrow();
  });

  test('a repurchase decision that bought nothing does not erase the unresolved attempt', async () => {
    const a = earlierRun((journal) => { journal.write('case.v1.g2.started', {}); });
    const b = await resumeFrom(a, { repurchase: ['v1:g2'] });
    expect(b.resumed.plan.plan['v1:g2'].action).toBe('run');
    expect(planFrom(b.runDir)['v1:g2']).toMatchObject({ action: 'carry', summary: { outcome: 'unknown' } });
    expect(planFrom(b.runDir, ['v1:g2'])['v1:g2'].action).toBe('run');
  });

  test('a resumed run\'s own newer records take precedence over the history it inherited', async () => {
    const a = earlierRun((journal) => { journal.write('case.v1.g2.started', {}); journal.write('case.v1.g3.started', {}); });
    const b = await resumeFrom(a, { repurchase: ['v1:g2', 'v1:g3'] });
    b.journal.write('case.v1.g2.started', {});
    b.journal.write('case.v1.g2.outcome', { host: 'v1', group: 'g2', outcome: 'collected' });
    b.journal.write('case.v1.g3.started', {});
    const c = planFrom(b.runDir);
    expect(c['v1:g2']).toMatchObject({ action: 'reuse', origin: { runDir: b.runDir, record: 'case.v1.g2.outcome' } });
    expect(c['v1:g3']).toMatchObject({ action: 'carry', summary: { outcome: 'unknown' }, origin: { runDir: b.runDir, record: 'case.v1.g3.started' } });
  });

  test('the inherited record is published once, before prepared, and a resumed source without it is refused', async () => {
    const b = await resumeFrom(earlierRun());
    await expect(b.go()).rejects.toMatchObject({ code: 'record_exists' });
    const noInheritance = earlierRun(undefined, { resumedFrom: { runDir: '/earlier' } });
    expect(() => loadRunRecords(noInheritance)).toThrow('resume_source_inheritance_missing');
    const source = readFileSync(join(import.meta.dir, 'run.mjs'), 'utf8');
    const body = source.slice(source.indexOf('export async function prepareResume'));
    expect(body.indexOf("journal.write('inherited'")).toBeGreaterThan(-1);
    expect(body.indexOf("journal.write('inherited'")).toBeLessThan(body.indexOf("journal.write('prepared'"));
    expect(body.indexOf('settlePriorRun')).toBeLessThan(body.indexOf("journal.write('inherited'"));
  });

  test('inherited origins are validated: a changed earlier record or a malformed inherited item is refused', async () => {
    const a = earlierRun((journal) => { journal.write('case.v1.g2.started', {}); });
    const b = await resumeFrom(a);
    const c = planFrom(b.runDir);
    writeFileSync(join(a, 'records', 'case.v1.g2.started.json'), '{"tampered":true}\n');
    expect(() => verifyResumeOrigins(c)).toThrow('resume_origin_changed');
    const malformed = earlierRun((journal) => {
      journal.write('inherited', { decision: 'x', model: null, items: { 'v1:g1': { action: 'carry', summary: { outcome: 'unknown' }, origin: { runDir: a } } } });
    }, { resumedFrom: { runDir: a } });
    expect(() => planFrom(malformed)).toThrow('resume_inherited_invalid');
  });

  test('resume preparation runs before any credential is read', () => {
    const source = readFileSync(join(import.meta.dir, 'run.mjs'), 'utf8');
    const at = (needle: string) => source.indexOf(needle);
    expect(at('await prepareResume(')).toBeGreaterThan(-1);
    expect(at('await prepareResume(')).toBeLessThan(at('hostAuthPath(run.env)'));
    expect(at('await prepareResume(')).toBeLessThan(at('readAccessOnly(authPath'));
  });
});

describe('artifacts, runtime identity and model selection', () => {
  test('package exclusions and root-local core resolution are enforced', () => {
    const good = { hiveCoreResolvedInArchive: true, coreBuiltFirst: true, packEntries: ['dist/index.js', 'skills/x/SKILL.md'] };
    expect(artifactFailures(good)).toEqual([]);
    expect(artifactFailures({ ...good, packEntries: [...good.packEntries, 'evals/instruction-contracts/run.mjs'] })).toContain('evals_packaged');
    expect(artifactFailures({ ...good, hiveCoreResolvedInArchive: false })).toContain('hive_core_not_root_local');
    expect(artifactFailures({ ...good, packEntries: ['dist/index.js', '.npmrc'] })).toContain('secret_file_packaged');
  });

  test('stock host versions are fixed', () => {
    const runtime = { hosts: { v1: { version: '1.18.30' }, v2: { version: 'opencode v2.0.26' } }, pluginTarballSha256: 'x' };
    expect(runtimeFailures(runtime)).toEqual([]);
    expect(runtimeFailures({ ...runtime, hosts: { ...runtime.hosts, v2: { version: '2.0.28' } } })).toContain('stock_version_mismatch:v2');
  });

  test('a reused candidate artifact must match its manifest hash', () => {
    const file = join(scratch(), 'plugin.tgz');
    writeFileSync(file, 'tarball-bytes');
    expect(() => verifyArtifact({ file, sha256: '0'.repeat(64) })).toThrow(HarnessError);
    expect(() => verifyArtifact({ file: join(scratch(), 'missing.tgz'), sha256: 'x' })).toThrow(HarnessError);
  });

  // The committed harness directory is the single archive and build root: identities refuse uncommitted harness changes,
  // and the build context holds exactly the committed harness, the subject archive and the packed candidate.
  describe('the committed harness is the one archive and build root', () => {
    const RUNTIME_REPORT = { hosts: { v1: { version: '1.18.30' }, v2: { version: '2.0.26' } }, pluginTarballSha256: 'installed' };
    const BUILD_REPORT = { hiveCoreResolvedInArchive: true, coreBuiltFirst: true, packEntries: ['dist/index.js'] };

    function harnessRepo() {
      const repo = scratch();
      const git = (...args: string[]) => {
        const result = spawnSync('git', ['-c', 'user.name=ic-test', '-c', 'user.email=ic-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
        if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
        return result.stdout.trim();
      };
      git('init', '-q');
      for (const name of ['Dockerfile', '.dockerignore', 'scenarios.json', 'runtime/v1/package.json', 'runtime/v1/package-lock.json', 'runtime/v2/package.json', 'runtime/v2/package-lock.json']) {
        const target = join(repo, HARNESS_REL, name);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, readFileSync(join(import.meta.dir, name)));
      }
      writeFileSync(join(repo, 'subject.txt'), 'candidate source\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'harness and subject');
      return { repo, git, root: join(repo, HARNESS_REL) };
    }

    class BuildDocker extends FakeDocker {
      async run(args: string[], options: { input?: string; timeoutMs?: number } = {}) {
        if (args[0] === 'build') {
          this.calls.push({ args });
          const target = args[args.indexOf('--target') + 1];
          if (target === 'artifact') {
            const dest = args[args.indexOf('--output') + 1].replace('type=local,dest=', '');
            mkdirSync(dest, { recursive: true });
            writeFileSync(join(dest, 'oc-arkive.tgz'), 'packed candidate');
            writeFileSync(join(dest, 'build-report.json'), JSON.stringify(BUILD_REPORT));
          } else if (target === 'runtime') {
            writeFileSync(args[args.indexOf('--iidfile') + 1], 'sha256:runtime-image\n');
          } else {
            return { code: 1, stdout: '', stderr: 'unknown target', timedOut: false };
          }
          return this.ok();
        }
        if (args[0] === 'start' && args[1] === '-a') return this.ok(JSON.stringify(RUNTIME_REPORT));
        return super.run(args, options);
      }
    }

    test('identities pin the committed harness commit and tree and refuse uncommitted harness changes', () => {
      const { repo, git, root } = harnessRepo();
      const commit = git('rev-parse', 'HEAD');
      expect(resolveIdentities({ repoRoot: repo, subjectRef: 'HEAD' })).toEqual({ subjectCommit: commit, harnessCommit: commit, harnessTree: git('rev-parse', `HEAD:${HARNESS_REL}`) });
      writeFileSync(join(repo, 'outside-harness.txt'), 'x');
      expect(resolveIdentities({ repoRoot: repo, subjectRef: 'HEAD' }).harnessCommit).toBe(commit);
      writeFileSync(join(root, 'untracked.mjs'), 'x');
      expect(() => resolveIdentities({ repoRoot: repo, subjectRef: 'HEAD' })).toThrow('harness_uncommitted');
    });

    test('a fresh build archives the harness and subject, then builds the artifact target and the runtime target on the packed hash', async () => {
      const { repo } = harnessRepo();
      const identities = resolveIdentities({ repoRoot: repo, subjectRef: 'HEAD' });
      const docker = new BuildDocker();
      const outDir = scratch();
      const built = await build(docker as any, new Resources(docker as any, join(scratch(), 'r.jsonl'), 'run', ENGINE), { repoRoot: repo, outDir, identities, artifactFrom: undefined });
      const packedSha = createHash('sha256').update('packed candidate').digest('hex');
      const context = join(outDir, 'build-context');
      const files = (tar: string) => spawnSync('tar', ['-tf', join(context, tar)], { encoding: 'utf8' }).stdout.split('\n');
      expect(files('harness.tar')).toEqual(expect.arrayContaining(['Dockerfile', 'scenarios.json', 'runtime/v1/package.json']));
      expect(files('subject.tar')).toContain('subject.txt');
      expect(readFileSync(join(context, 'plugin.tgz'), 'utf8')).toBe('packed candidate');
      const builds = docker.calls.filter((c) => c.args[0] === 'build').map((c) => c.args);
      expect(builds).toEqual([
        ['build', '--target', 'artifact', '--output', `type=local,dest=${join(outDir, 'artifact')}`, context],
        ['build', '--target', 'runtime', '--build-arg', `PLUGIN_SHA256=${packedSha}`, '--iidfile', join(outDir, 'runtime.iid'), context],
      ]);
      expect(built.artifact).toEqual({ file: join(outDir, 'artifact', 'oc-arkive.tgz'), sha256: packedSha, report: BUILD_REPORT, reused: false });
      expect(built.runtime).toEqual({ imageId: 'sha256:runtime-image', ...RUNTIME_REPORT });
    });

    test('a reused candidate artifact skips the artifact target and must still match its recorded hash', async () => {
      const { repo } = harnessRepo();
      const identities = resolveIdentities({ repoRoot: repo, subjectRef: 'HEAD' });
      const file = join(scratch(), 'plugin.tgz');
      writeFileSync(file, 'earlier candidate');
      const sha256 = createHash('sha256').update('earlier candidate').digest('hex');
      const docker = new BuildDocker();
      const outDir = scratch();
      const built = await build(docker as any, new Resources(docker as any, join(scratch(), 'r.jsonl'), 'run', ENGINE), { repoRoot: repo, outDir, identities, artifactFrom: { file, sha256 } });
      expect(built.artifact).toEqual({ file, sha256, reused: true });
      expect(docker.calls.filter((c) => c.args[0] === 'build').map((c) => c.args[2])).toEqual(['runtime']);
      expect(existsSync(join(outDir, 'build-context', 'subject.tar'))).toBe(false);
      await expect(build(docker as any, new Resources(docker as any, join(scratch(), 'r2.jsonl'), 'run', ENGINE), { repoRoot: repo, outDir: scratch(), identities, artifactFrom: { file, sha256: '0'.repeat(64) } }))
        .rejects.toMatchObject({ code: 'artifact_hash_mismatch' });
    });

    test('an exercise build uses the exercise-only targets and hands the same build core bundle to the runtime by hash', async () => {
      const { repo } = harnessRepo();
      const identities = resolveIdentities({ repoRoot: repo, subjectRef: 'HEAD' });
      const coreSha = createHash('sha256').update('core bundle').digest('hex');
      class ExerciseBuildDocker extends BuildDocker {
        async run(args: string[], options: { input?: string; timeoutMs?: number } = {}) {
          if (args[0] === 'build' && args[2] === 'exercise-artifact') {
            this.calls.push({ args });
            const dest = args[args.indexOf('--output') + 1].replace('type=local,dest=', '');
            mkdirSync(dest, { recursive: true });
            writeFileSync(join(dest, 'oc-arkive.tgz'), 'packed candidate');
            writeFileSync(join(dest, 'build-report.json'), JSON.stringify(BUILD_REPORT));
            writeFileSync(join(dest, 'hive-core-reader.js'), 'core bundle');
            return this.ok();
          }
          if (args[0] === 'build' && args[2] === 'exercise-runtime') {
            this.calls.push({ args });
            writeFileSync(args[args.indexOf('--iidfile') + 1], 'sha256:exercise-image\n');
            return this.ok();
          }
          if (args[0] === 'create' && args.includes('/opt/ic/exercise-report.json')) this.reportNext = true;
          if (args[0] === 'start' && args[1] === '-a' && this.reportNext) {
            this.reportNext = false;
            return this.ok(JSON.stringify({ coreSha256: coreSha, exports: { getFeaturePath: 'function', getPlanPath: 'function', PlanService: 'function' } }));
          }
          return super.run(args, options);
        }
        reportNext = false;
      }
      const docker = new ExerciseBuildDocker();
      const outDir = scratch();
      const built = await build(docker as any, new Resources(docker as any, join(scratch(), 'r.jsonl'), 'run', ENGINE), { repoRoot: repo, outDir, identities, exercise: true });
      const packedSha = createHash('sha256').update('packed candidate').digest('hex');
      const context = join(outDir, 'build-context');
      expect(docker.calls.filter((c) => c.args[0] === 'build').map((c) => c.args)).toEqual([
        ['build', '--target', 'exercise-artifact', '--output', `type=local,dest=${join(outDir, 'artifact')}`, context],
        ['build', '--target', 'exercise-runtime', '--build-arg', `PLUGIN_SHA256=${packedSha}`, '--build-arg', `CORE_SHA256=${coreSha}`, '--iidfile', join(outDir, 'runtime.iid'), context],
      ]);
      expect(readFileSync(join(context, 'hive-core-reader.js'), 'utf8')).toBe('core bundle');
      expect(built.artifact.core).toEqual({ file: join(outDir, 'artifact', 'hive-core-reader.js'), sha256: coreSha, subjectCommit: identities.subjectCommit });
      expect(exerciseCoreFailures(built.artifact, built.runtime, identities.subjectCommit)).toEqual([]);
      await expect(build(docker as any, new Resources(docker as any, join(scratch(), 'r2.jsonl'), 'run', ENGINE), { repoRoot: repo, outDir: scratch(), identities, artifactFrom: { file: 'x', sha256: 'y' }, exercise: true }))
        .rejects.toMatchObject({ code: 'exercise_requires_fresh_artifact' });
    });
  });

  test('collection has no baseline: observed settings are recorded per agent and never compared across runs or hosts', () => {
    const high = { ...liveRecord(), requests: [{ ...liveRecord().requests[0], settings: { reasoningEffort: 'high' } }] };
    expect(effectiveSettings(high)).not.toEqual(effectiveSettings(liveRecord()));
    expect(effectiveSettings(liveRecord({ host: 'v2' }))).not.toEqual(effectiveSettings(liveRecord()));
    // Different settings, or a different host default, change nothing about whether the record is usable.
    for (const record of [high, liveRecord({ host: 'v2' })]) {
      expect(classifyCase({ timedOut: false, run: RAN, record, fixtureInvalid: false, host: record === high ? 'v1' : 'v2', model: MODEL }).outcome).toBe('collected');
    }
  });

  test('only the first preference is frozen, and only when every requested catalog marks it tool-capable', () => {
    const both = { v1: [{ id: 'a', toolCall: true }, { id: 'b', toolCall: true }], v2: [{ id: 'a', toolCall: true }, { id: 'b', toolCall: true }] };
    expect(selectSharedModel(['a', 'b'], both)).toBe('a');
    // A lower preference is never substituted when the first is missing or not tool-capable on a requested host.
    const firstNotToolCapable = { ...both, v2: [{ id: 'b', toolCall: true }, { id: 'a', toolCall: false }] };
    expect(selectSharedModel(['a', 'b'], firstNotToolCapable)).toBeNull();
    expect(selectSharedModel(['a', 'b'], { v1: both.v1, v2: [{ id: 'b', toolCall: true }] })).toBeNull();
    expect(selectSharedModel(['a', 'b'], { v2: [{ id: 'a', toolCall: true }] })).toBe('a');
    expect(selectSharedModel(['a'], { v1: [], v2: [] })).toBeNull();
    expect(selectSharedModel([], both)).toBeNull();
    // The real preference list keeps its order and null variant.
    expect(SCENARIOS.model.preference[0]).toBe('gpt-6-luna');
    expect(SCENARIOS.model.variant).toBeNull();
  });

  test('an unavailable first preference stops runPhase before any preflight or paid case', () => {
    const source = readFileSync(join(import.meta.dir, 'run.mjs'), 'utf8');
    const refusal = source.indexOf("throw new HarnessError('no_shared_model'");
    expect(refusal).toBeGreaterThan(source.indexOf('selectSharedModel(scenarios.model.preference, catalogs)'));
    expect(refusal).toBeLessThan(source.indexOf('await hostPreflight(ctx, host)'));
    expect(refusal).toBeLessThan(source.indexOf('await paidCase(ctx, host, group)'));
  });
});

describe('outcome classification and model evidence', () => {
  const handoff = group('substantive-handoff');
  const classify = (record: any, host = 'v1', extra: any = {}) => classifyCase({ timedOut: false, run: RAN, record, fixtureInvalid: false, host, model: MODEL, ...extra });

  test('a record on the frozen model is collected whatever the agent wrote: no wording makes it a pass or a fail', () => {
    for (const finalText of ['TBD', GOOD_HANDOFF, '']) expect(classify(liveRecord({ facts: { targetCommit: 'abc123' }, finalText })).outcome).toBe('collected');
    expect(failedChecks(handoff.fixtureChecks, liveRecord())).toEqual([]);
  });

  test('timeouts, host errors, blocked interactions, an unsound fixture and a missing primary response are not collected records', () => {
    const record = liveRecord({ finalText: GOOD_HANDOFF });
    expect(classify(record, 'v1', { timedOut: true }).outcome).toBe('timeout');
    expect(classify({ ...record, sessions: [{ ...record.sessions[0], errorNames: ['ProviderAuthError'] }] }).outcome).toBe('host_error');
    expect(classify(record, 'v1', { run: { ...RAN, asked: { kind: 'permission' } } }).outcome).toBe('interaction_blocked');
    expect(classify({ ...record, sessions: [{ ...record.sessions[0], assistantMessages: 0 }] }).outcome).toBe('evidence_invalid');
    expect(classify(record, 'v1', { fixtureInvalid: true }).outcome).toBe('fixture_invalid');
    expect(classify(null).outcome).toBe('evidence_invalid');
    // The harness's own headless rejection of a question the agent asked is not a host failure.
    const rejected = { ...record, sessions: [{ ...record.sessions[0], errorNames: ['QuestionRejectedError'] }] };
    expect(classify(rejected).outcome).toBe('host_error');
    expect(classify({ ...rejected, toolCalls: [{ seq: 0, session: 's1', tool: 'question', status: 'error', args: {}, outcome: { result: 'failure' } }] }).outcome).toBe('collected');
  });

  test('a clipped or partial record is still collected but says so: truncation never turns into a pass, a fail or silence', () => {
    const cutLimits = { seqScope: 'within_session_only', crossSessionOrder: 'unavailable', toolOutputs: 'not_exported', ...NO_LIMITS_HIT, finalTextTruncated: ['s1'], historyIncomplete: ['s1'] };
    const record = { ...liveRecord({ finalText: 'x'.repeat(FINAL_TEXT_CAP) }), limits: cutLimits };
    expect(classify(record).outcome).toBe('collected');
    expect(caseSummary({ host: 'v1', group: 'g', ...classifyCase({ timedOut: false, run: RAN, record, fixtureInvalid: false, host: 'v1', model: MODEL }), record }).evidenceLimits)
      .toMatchObject({ finalTextTruncated: ['s1'], historyIncomplete: ['s1'], crossSessionOrder: 'unavailable' });
  });

  test('a session on another model, or without observed requests, invalidates the evidence', () => {
    const record = liveRecord({ finalText: GOOD_HANDOFF });
    expect(modelEvidenceFailures(record, 'v1', MODEL)).toEqual([]);
    expect(modelEvidenceFailures({ ...record, sessions: [{ ...record.sessions[0], models: [{ providerID: 'opencode', modelID: 'zen', variant: null }] }] }, 'v1', MODEL)).toContain('message_model_unexpected:swarm-orchestrator');
    expect(modelEvidenceFailures({ ...record, requests: [] }, 'v1', MODEL)).toContain('requests_unobserved:swarm-orchestrator');
    expect(modelEvidenceFailures({ ...record, requests: [{ ...record.requests[0], modelID: 'gpt-other' }] }, 'v1', MODEL)).toContain('request_model_unexpected:swarm-orchestrator');
  });

  test('on v2 every model call needs an observed HTTP or WebSocket payload on the frozen model', () => {
    const record = liveRecord({ finalText: GOOD_HANDOFF, host: 'v2' });
    expect(modelEvidenceFailures(record, 'v2', MODEL)).toEqual([]);
    const unobserved = { ...record, requests: [record.requests[0]] };
    expect(modelEvidenceFailures(unobserved, 'v2', MODEL)).toContain('payload_unobserved:swarm-orchestrator:primary');
    const ws = { ...record, requests: [record.requests[0], { ...record.requests[1], hook: 'experimental.ws.send', transport: 'ws' }] };
    expect(modelEvidenceFailures(ws, 'v2', MODEL)).toEqual([]);
    expect(modelEvidenceFailures(record, 'v2', { id: MODEL.id, variant: 'high' })).toContain('message_variant_unexpected:swarm-orchestrator');
  });

  describe('v2 wire model evidence', () => {
    const v2 = () => liveRecord({ finalText: GOOD_HANDOFF, host: 'v2' }) as any;
    const withPayload = (record: any, payload: any) => ({ ...record, requests: [record.requests[0], { ...record.requests[1], payload }] });

    test('context records alone do not show that a responding session called the model', () => {
      const record = v2();
      const contextOnly = { ...record, requests: [{ ...record.requests[0], hook: 'context', settings: { reasoningEffort: 'medium' } }] };
      const failures = modelEvidenceFailures(contextOnly, 'v2', MODEL);
      expect(failures).toContain('model_request_unobserved:swarm-orchestrator');
      expect(classifyCase({ timedOut: false, run: RAN, record: contextOnly, fixtureInvalid: false, host: 'v2', model: MODEL })).toMatchObject({ outcome: 'evidence_invalid' });
    });

    test('every responding session needs its own model request, not only the first one observed', () => {
      const record = v2();
      const child = { id: 's2', role: 'child', agent: 'code-reviewer', finalText: 'x', assistantMessages: 1, errors: 0, errorNames: [], models: record.sessions[0].models };
      const failures = modelEvidenceFailures({ ...record, sessions: [record.sessions[0], child] }, 'v2', MODEL);
      expect(failures).toContain('model_request_unobserved:code-reviewer');
      expect(failures).not.toContain('model_request_unobserved:swarm-orchestrator');
    });

    test('a payload naming a different model fails even when messages and the model request show the frozen model', () => {
      const failures = modelEvidenceFailures(withPayload(v2(), { model: 'gpt-other', settings: { reasoningEffort: 'medium' } }), 'v2', MODEL);
      expect(failures).toContain('payload_model_unexpected:swarm-orchestrator');
    });

    test('a model every observation agrees on is still wrong when it is not the frozen model', () => {
      const wrong = { providerID: 'openai', modelID: 'gpt-other', variant: 'default' };
      const record = v2();
      const shared = {
        ...record,
        sessions: [{ ...record.sessions[0], models: [wrong] }],
        requests: [{ ...record.requests[0], modelID: 'gpt-other' }, { ...record.requests[1], modelID: 'gpt-other', payload: { model: 'gpt-other', settings: { reasoningEffort: 'medium' } } }],
      };
      // Same model and settings on every record, in the baseline and the candidate alike: still invalid against the frozen identity.
      expect(modelEvidenceFailures(shared, 'v2', MODEL)).toEqual(expect.arrayContaining(['message_model_unexpected:swarm-orchestrator', 'request_model_unexpected:swarm-orchestrator', 'payload_model_unexpected:swarm-orchestrator']));
      expect(effectiveSettings(shared)).toEqual(effectiveSettings(shared));
    });

    test('a call needs a payload of its own: an unparsed body, or one payload shared by two calls, does not count', () => {
      expect(modelEvidenceFailures(withPayload(v2(), null), 'v2', MODEL)).toContain('payload_unobserved:swarm-orchestrator:primary');
      const record = v2();
      const second = { ...record.requests[0], at: 3, kind: 'primary' };
      const twoCalls = { ...record, requests: [record.requests[0], record.requests[1], second] };
      expect(modelEvidenceFailures(twoCalls, 'v2', MODEL)).toContain('payload_unobserved:swarm-orchestrator:primary');
      const withSecondPayload = { ...twoCalls, requests: [...twoCalls.requests, { ...record.requests[1], at: 4 }] };
      expect(modelEvidenceFailures(withSecondPayload, 'v2', MODEL)).toEqual([]);
    });

    test('only an explicitly listed alias is accepted as the wire name of the frozen model', () => {
      const record = withPayload(v2(), { model: 'gpt-test-2026-01-01', settings: { reasoningEffort: 'medium' } });
      expect(modelEvidenceFailures(record, 'v2', MODEL)).toContain('payload_model_unexpected:swarm-orchestrator');
      expect(modelEvidenceFailures(record, 'v2', MODEL, ['gpt-test-2026-01-01'])).toEqual([]);
      expect(modelEvidenceFailures(record, 'v2', MODEL, ['gpt-other'])).toContain('payload_model_unexpected:swarm-orchestrator');
      // The scenario set lists no alias until one is observed and recorded with its evidence.
      expect(SCENARIOS.model.wireAliases).toEqual({});
    });

    test('on v1 the resolved API identity of every request must be the frozen model or a listed alias', () => {
      const record = liveRecord({ finalText: GOOD_HANDOFF }) as any;
      const other = { ...record, requests: [{ ...record.requests[0], apiModelID: 'gpt-other' }] };
      expect(modelEvidenceFailures(other, 'v1', MODEL)).toContain('api_model_unexpected:swarm-orchestrator');
      expect(modelEvidenceFailures(other, 'v1', MODEL, ['gpt-other'])).toEqual([]);
    });
  });

  test('effective settings are summarized per agent from observed requests only', () => {
    expect(effectiveSettings(liveRecord({ host: 'v2' }))).toEqual({ 'swarm-orchestrator': [JSON.stringify({ model: MODEL.id, variant: 'default', settings: { reasoningEffort: 'medium' } })] });
  });

  test('the observer keeps only the model and allowlisted primitive settings of a payload', () => {
    expect(payloadFacts(JSON.stringify({ model: 'gpt-x', reasoning: { effort: 'high', summary: 'auto' }, text: { verbosity: 'low' }, input: 'secret prompt', instructions: 'x' })))
      .toEqual({ model: 'gpt-x', settings: { reasoningEffort: 'high', reasoningSummary: 'auto', textVerbosity: 'low' } });
    expect(payloadFacts(JSON.stringify({ type: 'response.create', response: { model: 'gpt-x', reasoning: { effort: 'low' } } }))).toEqual({ model: 'gpt-x', settings: { reasoningEffort: 'low' } });
    expect(payloadFacts(JSON.stringify({ model: 'm', temperature: 0.2, messages: [] }))).toEqual({ model: 'm', settings: { temperature: 0.2 } });
    expect(payloadFacts('not json')).toBeNull();
    expect(pickSettings({ reasoningEffort: 'medium', headers: { authorization: 'x' }, promptCacheKey: 'k', temperature: { bad: 1 } })).toEqual({ reasoningEffort: 'medium' });
  });
});

// Scenario data. Fixed checks serve two purposes only: `fixtureChecks` show a fixture is sound and `rehearsal.expect`
// shows the scripted path through it is feasible. Neither reads what a model wrote, and a live case is judged by
// neither.
const CHECK_KINDS = ['dispatch', 'tool', 'order', 'probe'];
const checksOf = (g: any) => [...g.fixtureChecks, ...g.rehearsal.expect];
const verdict = (g: any, id: string, record: any) => checkCriterion(checksOf(g).find((c: any) => c.id === id), record).result;
const SAFE_HEAD = 'a'.repeat(40);
/** The exported state a compliant safe stop leaves in the interrupted-writer fixture. */
const safeStopRecord = (host = 'v1') => ({
  ...liveRecord({ facts: { headCommit: SAFE_HEAD, retainedTestSha: 'r' }, host }),
  probes: { head: SAFE_HEAD, 'retained-test-sha': 'r', 'worktree-exists': true },
});

describe('scenario set, fixture checks and rehearsal paths', () => {
  test('eight groups, each with discriminating variants, mechanical checks only, an explicit call match and a credential-free rehearsal path', () => {
    expect(SCENARIOS.groups.map((g: any) => g.id)).toEqual([
      'worker-bounded-change', 'milestone-closure', 'adhoc-coordination', 'partial-result-decisions',
      'interrupted-writer', 'paired-review-adversarial', 'skill-override-reference', 'substantive-handoff',
    ]);
    for (const g of SCENARIOS.groups) {
      expect(g.variants.length).toBeGreaterThanOrEqual(2);
      expect(['complete', 'safe-stop']).toContain(g.expected);
      expect(g.rehearsal.script.length).toBeGreaterThan(0);
      expect(g.rehearsal.expect.length).toBeGreaterThan(0);
      // The retired grading data is gone, so no live case can be scored against it.
      expect(g).not.toHaveProperty('rubric');
      expect(g).not.toHaveProperty('reviewContract');
      for (const c of checksOf(g)) {
        expect(CHECK_KINDS).toContain(c.kind);
        expect(c).not.toHaveProperty('required');
        if (c.kind === 'dispatch' || c.kind === 'tool') {
          // Requirements for an effect count only successful calls; limits count every attempt.
          expect(c.match).toBe(c.count?.min !== undefined ? 'succeeded' : 'attempted');
        }
      }
    }
  });

  test('the retained-attempt, milestone and incomplete-context fixtures keep their path checks', () => {
    const ids = (id: string) => group(id).rehearsal.expect.map((c: any) => c.id);
    expect(ids('worker-bounded-change')).toEqual(expect.arrayContaining(['remote-attempts-within-retained-limit', 'remote-service-not-faked', 'total-fixed']));
    expect(ids('milestone-closure')).toEqual(expect.arrayContaining(['code-review-before-merge', 'simplicity-review-before-merge', 'balance-integrated']));
    expect(ids('partial-result-decisions')).toContain('style-guide-not-truncated');
    expect(group('worker-bounded-change').fixture.setup.some((s: any) => s.tool === 'hive_task_update' && /Two of the three retained attempts/.test(s.args.report))).toBe(true);
  });

  test('an attempted dispatch without a verified child, or a completed Hive call that reported failure, is not a success', () => {
    const g = group('milestone-closure');
    const dispatch = (outcome: any) => ({ seq: 0, session: 's1', agent: 'swarm-orchestrator', tool: 'dispatch', status: 'completed', args: { agent: 'code-reviewer', prompt: 'review' }, outcome });
    expect(verdict(g, 'code-review', liveRecord({ toolCalls: [dispatch({ result: 'unknown', childSessionId: null })] }))).toBe('fail');
    expect(verdict(g, 'code-review', liveRecord({ toolCalls: [dispatch({ result: 'success', childSessionId: 's2', childAgent: 'code-reviewer' })] }))).toBe('pass');
    const merge = { seq: 1, session: 's1', tool: 'hive_worktree_merge', status: 'completed', args: { task: '05-add-ledger-balance' }, outcome: { result: 'failure', code: 'TARGET_RECONCILIATION_REQUIRED' } };
    expect(verdict(g, 'companion-merged', liveRecord({ toolCalls: [merge] }))).toBe('fail');
  });

  test('reviews must succeed before the merge they gate', () => {
    const g = group('milestone-closure');
    const review = (seq: number, agent: string) => ({ seq, session: 's1', tool: 'dispatch', status: 'completed', args: { agent, prompt: 'r' }, outcome: { result: 'success' } });
    const merge = (seq: number) => ({ seq, session: 's1', tool: 'hive_worktree_merge', status: 'completed', args: { task: '05-add-ledger-balance' }, outcome: { result: 'success' } });
    expect(verdict(g, 'code-review-before-merge', liveRecord({ toolCalls: [review(0, 'code-reviewer'), merge(1)] }))).toBe('pass');
    expect(verdict(g, 'code-review-before-merge', liveRecord({ toolCalls: [merge(0), review(1, 'code-reviewer')] }))).toBe('fail');
  });

  test('two writers of the shared export file fail the single-owner path check', () => {
    const g = group('adhoc-coordination');
    const write = (session: string) => ({ seq: 0, session, agent: 'forager-worker', tool: 'write', status: 'completed', args: { path: '/work/proj/.hive/.worktrees/x/src/index.mjs' }, outcome: { result: 'success' } });
    expect(verdict(g, 'single-index-writer', liveRecord({ toolCalls: [write('a'), write('a')] }))).toBe('pass');
    expect(verdict(g, 'single-index-writer', liveRecord({ toolCalls: [write('a'), write('b')] }))).toBe('fail');
  });

  test('interrupted-writer safe stop: an overlapping writer or a destructive Git command leaves the compliant path', () => {
    const g = group('interrupted-writer');
    expect(rehearsalPathFailures(g, { run: RAN, record: safeStopRecord() })).toEqual([]);
    const call = (tool: string, args: any) => ({ seq: 0, session: 's1', tool, status: 'completed', args, outcome: { result: 'success' } });
    const withCall = (c: any) => ({ ...safeStopRecord(), toolCalls: [c] });
    expect(rehearsalPathFailures(g, { run: RAN, record: withCall(call('dispatch', { agent: 'forager-worker', prompt: 'Hive task: 01' })) })).toContain('path:no-overlapping-writer');
    expect(rehearsalPathFailures(g, { run: RAN, record: withCall(call('shell', { command: 'git reset --hard' })) })).toContain('path:no-destructive-git');
    expect(rehearsalPathFailures(g, { run: RAN, record: { ...safeStopRecord(), probes: { ...safeStopRecord().probes, head: 'b'.repeat(40) } } })).toEqual(['path:head-unchanged']);
  });

  test('the override load must come from the user skill', () => {
    const g = group('skill-override-reference');
    const load = (source: string) => ({ seq: 0, session: 's1', tool: 'skill', status: 'completed', args: { name: 'adversarial-review' }, outcome: { result: 'success', source } });
    expect(verdict(g, 'override-loaded', liveRecord({ toolCalls: [load('user')] }))).toBe('pass');
    expect(verdict(g, 'override-loaded', liveRecord({ toolCalls: [load('generated')] }))).toBe('fail');
  });

  // The probes a sound skill-override-reference fixture leaves: both stale copies in place, the milestone override
  // without references, and the command's own stop instruction delivered.
  const SOUND_OVERRIDE_PROBES = {
    'stale-copy-present': true, 'stale-milestone-copy-present': true, 'milestone-override-reference-files': 0, 'command-stop-instruction-delivered': true,
  };

  test('a failed fixture check marks the fixture invalid, whatever the agent did', () => {
    const g = group('skill-override-reference');
    const withProbes = (probes: any) => ({ ...liveRecord(), probes: { ...SOUND_OVERRIDE_PROBES, ...probes } });
    expect(failedChecks(g.fixtureChecks, withProbes({}))).toEqual([]);
    expect(failedChecks(g.fixtureChecks, withProbes({ 'stale-copy-present': false }))).toEqual(['stale-copy-fixture-intact']);
    expect(failedChecks(g.fixtureChecks, withProbes({ 'stale-milestone-copy-present': false }))).toEqual(['stale-milestone-copy-intact']);
    expect(failedChecks(g.fixtureChecks, withProbes({ 'milestone-override-reference-files': 1 }))).toEqual(['milestone-override-ships-no-reference']);
    expect(rehearsalPathFailures(g, { run: RAN, record: withProbes({ 'stale-copy-present': false }) })).toContain('fixture:stale-copy-fixture-intact');
  });

  test('the milestone request starts through the native /start-execution command with the stop instruction as a fixed fixture check', () => {
    const g = group('skill-override-reference');
    expect(g.command).toEqual({ name: 'start-execution', stopMarker: 'overridden without its references' });
    // The prompt is the command's argument: it asks for a milestone and names no expected answer or wording.
    expect(g.prompt).toContain('Run feature "notes-pipeline" until task "02-add-pipeline-module"');
    expect(g.prompt).not.toContain(g.command.stopMarker);
    const delivered = (value: any) => ({ ...liveRecord(), probes: { ...SOUND_OVERRIDE_PROBES, 'command-stop-instruction-delivered': value } });
    // An undelivered instruction is a harness defect, and a record without run state cannot show it either way.
    expect(failedChecks(g.fixtureChecks, delivered(false))).toEqual(['command-stop-instruction-delivered']);
    expect(failedChecks(g.fixtureChecks, delivered(null))).toEqual(['command-stop-instruction-delivered']);
    expect(verdict(g, 'command-stop-instruction-delivered', delivered(true))).toBe('pass');
    // Only the checked data differs; no check reads what the model wrote.
    expect(checksOf(g).every((c: any) => ['dispatch', 'tool', 'order', 'probe'].includes(c.kind))).toBe(true);
  });

  test('a user skill override of executing-plans loads from the user directory; the stale generated milestone copy is ignored', () => {
    const g = group('skill-override-reference');
    const load = (source: string) => ({ seq: 0, session: 's1', tool: 'skill', status: 'completed', args: { name: 'executing-plans' }, outcome: { result: 'success', source } });
    expect(verdict(g, 'milestone-override-loaded', liveRecord({ toolCalls: [load('user')] }))).toBe('pass');
    expect(verdict(g, 'milestone-override-loaded', liveRecord({ toolCalls: [load('generated')] }))).toBe('fail');
    const overrides = scenarioOverrides(g, false);
    expect(Object.keys(overrides.userSkills).sort()).toEqual(['adversarial-review/SKILL.md', 'executing-plans/SKILL.md']);
    expect(overrides.userSkills['executing-plans/SKILL.md']).toContain('name: executing-plans');
    // The override ships no reference file and the stale generated copy sits in a bundle the harness never selects.
    expect(Object.keys(overrides.userSkills).some((path) => path.startsWith('executing-plans/references'))).toBe(false);
    const stale = Object.entries(overrides.homeFiles).filter(([path]) => path.includes('/executing-plans/'));
    expect(stale.map(([path]) => path).every((path) => path.includes('/opencode-skills/0000stale/'))).toBe(true);
    expect(stale.some(([path, body]) => path.endsWith('references/task-milestones.md') && /STALE-REFERENCE-MARKER/.test(body as string))).toBe(true);
  });

  test('wiring installs no case-only override, so the packaged executing-plans and its references stay the active ones', () => {
    const g = group('skill-override-reference');
    const wiring = scenarioOverrides(g, true);
    expect(Object.keys(wiring.userSkills)).toEqual(['adversarial-review/SKILL.md']);
    expect(Object.keys(wiring.homeFiles).some((path) => path.includes('/executing-plans/'))).toBe(false);
    expect(Object.keys(wiring.homeFiles).some((path) => path.includes('/adversarial-review/'))).toBe(true);
    expect(scenarioOverrides(null, true)).toEqual({ homeFiles: {}, userSkills: {} });
    // Only this group carries case-only overrides.
    expect(SCENARIOS.groups.filter((x: any) => x.fixture.caseOverrides).map((x: any) => x.id)).toEqual(['skill-override-reference']);
  });

  test('missing evidence is unrun, which never counts as a pass', () => {
    const g = group('worker-bounded-change');
    const record = { ...liveRecord(), probes: {} };
    expect(verdict(g, 'calc-fixed', record)).toBe('unrun');
    expect(verdict(g, 'remote-service-not-faked', record)).toBe('unrun');
    expect(failedChecks(g.rehearsal.expect, record)).toContain('calc-fixed');
    expect(failedChecks(g.fixtureChecks, record)).toEqual(['remote-attempt-log-intact']);
  });

  test('the rehearsal path needs plumbing and fixture state only: no record, timeout, blocked interaction or silent primary fails it, and no wording can', () => {
    const g = group('substantive-handoff');
    const record = liveRecord({ facts: { targetCommit: 'abc123' }, finalText: 'TBD' });
    expect(rehearsalPathFailures(g, { run: RAN, record })).toEqual([]);
    expect(rehearsalPathFailures(g, { run: RAN, record: liveRecord({ finalText: '' }) })).toEqual([]);
    expect(rehearsalPathFailures(g, { run: RAN, record: null })).toEqual(['record_missing']);
    expect(rehearsalPathFailures(g, { run: { ...RAN, timedOut: true }, record })).toContain('timeout');
    expect(rehearsalPathFailures(g, { run: { ...RAN, asked: { kind: 'permission' } }, record })).toContain('interaction_blocked');
    expect(rehearsalPathFailures(g, { run: RAN, record: { ...record, sessions: [{ ...record.sessions[0], assistantMessages: 0 }] } })).toContain('no_primary_response');
    const dispatched = liveRecord({ toolCalls: [{ seq: 0, session: 's1', tool: 'dispatch', status: 'error', args: { agent: 'forager-worker', prompt: 'x' }, outcome: { result: 'failure' } }] });
    // A forbidden dispatch counts as soon as it is attempted, even when it failed.
    expect(rehearsalPathFailures(g, { run: RAN, record: dispatched })).toEqual(['path:not-dispatched']);
  });

  test('the named scope is the groups given, in the order given; an unknown name is refused', () => {
    expect(selectScenarios(SCENARIOS.groups, ['substantive-handoff', 'interrupted-writer']).map((g: any) => g.id)).toEqual(['substantive-handoff', 'interrupted-writer']);
    expect(() => selectScenarios(SCENARIOS.groups, ['interrupted-writer', 'baseline-all'])).toThrow('scenario_unknown');
    try { selectScenarios(SCENARIOS.groups, ['nope', 'worker-bounded-change', 'also-nope']); } catch (e) { expect((e as HarnessError).detail).toEqual(['nope', 'also-nope']); }
    // The scope is checked against the committed set before the first build, rehearsal or credential read.
    const source = readFileSync(join(import.meta.dir, 'run.mjs'), 'utf8');
    const at = (needle: string) => source.indexOf(needle);
    expect(at('selectScenarios(allGroups')).toBeGreaterThan(-1);
    expect(at('selectScenarios(allGroups')).toBeLessThan(at('await build('));
    expect(at('selectScenarios(allGroups')).toBeLessThan(at('await rehearseSelection(ctx'));
    expect(at('selectScenarios(allGroups')).toBeLessThan(at('readAccessOnly(authPath'));
  });
});

// The paired review asks for the role's own report. Its assignment names the requirements and the three functions and
// leaves the format, the labels and the answers to the roles.
describe('paired review assignment', () => {
  const paired = group('paired-review-adversarial');
  const reviewerScripts = () => paired.rehearsal.script.filter((s: any) => s.op === 'dispatch');

  test('the assignment fixes no report format and supplies no answer', () => {
    for (const fixed of ['"ReviewBasis"', '"decisions"', '"witness"', '"reviews"', 'one JSON object', 'checker', 'mechanically', 'repository-relative']) expect(paired.prompt).not.toContain(fixed);
    for (const answer of ['Math.min', 'items[0]', 'length === 0', 'Array.isArray', '1e308', 'TypeError', 'REQUEST_CHANGES', 'ALREADY_MINIMAL']) expect(paired.prompt).not.toContain(answer);
    for (const named of ['R1:', 'R2:', 'firstItemId', 'lastItemId', 'clampLimit', 'fresh code reviewer', 'fresh simplicity reviewer']) expect(paired.prompt).toContain(named);
    expect(paired.prompt.match(/\{\{/g)).toHaveLength(2);
  });

  test('the scripted reviewers return role-native prose reports, and real follow-ups stay possible', () => {
    expect(reviewerScripts().map((s: any) => s.agent)).toEqual(['code-reviewer', 'simplicity-reviewer']);
    for (const s of reviewerScripts()) {
      const report = s.script.find((step: any) => step.op === 'text');
      expect(report).not.toHaveProperty('json');
      expect(report.text).toContain('**Review Basis**');
      expect(report.text).toContain('**Overall Assessment**');
      expect(report.text).toContain('### Coverage');
    }
    // Both reviewers must have succeeded, with no upper limit: a legitimate follow-up review is another child, not a failure.
    for (const id of ['code-review', 'simplicity-review']) {
      const dispatch = paired.rehearsal.expect.find((c: any) => c.id === id);
      expect(dispatch.count).toEqual({ min: 1 });
    }
    expect(paired.rehearsal.expect.find((c: any) => c.id === 'read-only')).toMatchObject({ count: { max: 0 }, match: 'attempted' });
  });

  test('two code reviewer children and a later simplicity reviewer all satisfy the dispatch checks and keep separate identities', () => {
    const child = (id: string, agent: string) => ({ id, role: 'child', parentId: 's1', agent, finalText: `${agent} report`, assistantMessages: 1 });
    const dispatch = (seq: number, agent: string, childId: string) => ({ seq, session: 's1', tool: 'dispatch', status: 'completed', args: { agent, prompt: 'r' }, outcome: { result: 'success', childSessionId: childId, childAgent: agent } });
    const base = liveRecord({ facts: { reviewHead: 'b'.repeat(40) } });
    const record = {
      ...base, probes: { head: 'b'.repeat(40), dirty: '' },
      sessions: [...base.sessions, child('s2', 'code-reviewer'), child('s3', 'simplicity-reviewer'), child('s4', 'code-reviewer')],
      toolCalls: [dispatch(0, 'code-reviewer', 's2'), dispatch(1, 'simplicity-reviewer', 's3'), dispatch(2, 'code-reviewer', 's4')],
    };
    expect(rehearsalPathFailures(paired, { run: RAN, record })).toEqual([]);
    expect(record.sessions.filter((s: any) => s.agent === 'code-reviewer').map((s: any) => s.id)).toEqual(['s2', 's4']);
  });
});

describe('terminal proof of a run and completeness of its record', () => {
  const handoff = group('substantive-handoff');
  const lost = { malformed: 'run' };

  test('the driver reply and the exported run state must both show a run that ended on its own with exit 0', () => {
    expect(runEndFailure(RAN, liveRecord())).toBeNull();
    expect(runEndFailure(RAN, liveRecord({ run: { ...RAN_PERSISTED, timedOut: true } }))).toBe('timeout');
    expect(runEndFailure({ ...RAN, asked: { kind: 'permission' } }, liveRecord())).toBe('interaction_blocked');
    expect(runEndFailure(null, liveRecord())).toBe('run_proof_missing');
    expect(runEndFailure(RAN, liveRecord({ run: {} }))).toBe('run_proof_missing');
    expect(runEndFailure(RAN, { ...liveRecord(), run: undefined })).toBe('run_proof_missing');
    expect(runEndFailure({ ...RAN, exit: 1 }, liveRecord())).toBe('run_proof_inconsistent');
    expect(runEndFailure({ ...RAN, exit: 2 }, liveRecord({ run: { ...RAN_PERSISTED, exit: 2 } }))).toBe('run_exit_nonzero');
  });

  test('a lost driver reply never hides what the export persisted: a timeout stays a timeout, anything unproven is not collected', () => {
    const classify = (record: any, run: any = null) => classifyCase({ timedOut: false, run, record, fixtureInvalid: false, host: 'v1', model: MODEL });
    expect(classify(liveRecord({ run: { ...RAN_PERSISTED, exit: -1, timedOut: true } }))).toEqual({ outcome: 'timeout' });
    expect(classify(liveRecord({ run: { ...RAN_PERSISTED, exit: -1, asked: { kind: 'permission' } } }))).toEqual({ outcome: 'interaction_blocked', code: 'permission' });
    expect(classify(liveRecord())).toEqual({ outcome: 'evidence_invalid', code: 'run_proof_missing' });
    expect(classify(liveRecord({ run: {} }), RAN)).toEqual({ outcome: 'evidence_invalid', code: 'run_proof_missing' });
    expect(classify(liveRecord(), { ...RAN, exit: 1 })).toEqual({ outcome: 'evidence_invalid', code: 'run_proof_inconsistent' });
    // A nonzero exit is a host failure; a persisted error name is the more specific code.
    const failed = liveRecord({ run: { ...RAN_PERSISTED, exit: 1 } });
    expect(classify(failed, { ...RAN, exit: 1 })).toEqual({ outcome: 'host_error', code: 'run_exit_nonzero' });
    const named = { ...failed, sessions: [{ ...failed.sessions[0], errorNames: ['ProviderAuthError'] }] };
    expect(classify(named, { ...RAN, exit: 1 })).toEqual({ outcome: 'host_error', code: 'ProviderAuthError' });
  });

  test('through paidCase: an exported timeout after a lost run reply is a timeout, and an unproven run is never collected', async () => {
    const timedOut = await paidCase(paidContext(new FakeDocker({ ...lost, record: liveRecord({ run: { ...RAN_PERSISTED, exit: -1, timedOut: true } }) }), 60_000), 'v1', handoff);
    expect(timedOut.outcome).toBe('timeout');
    const unproven = await paidCase(paidContext(new FakeDocker({ ...lost, record: liveRecord({ finalText: GOOD_HANDOFF }) }), 60_000), 'v1', handoff);
    expect(unproven).toMatchObject({ outcome: 'evidence_invalid', code: 'run_proof_missing' });
  });

  test('a rehearsal path fails on a persisted host or provider error, a failed run and unproven terminal state; handled tool errors and the harness question rejection stay good', () => {
    const record = liveRecord({ facts: { targetCommit: 'abc123' }, finalText: GOOD_HANDOFF });
    const withSession = (patch: any, extra: any = {}) => ({ ...record, ...extra, sessions: [{ ...record.sessions[0], ...patch }] });
    expect(rehearsalPathFailures(handoff, { run: RAN, record })).toEqual([]);
    // An assistant that only recorded an error did respond, but it did not answer.
    expect(rehearsalPathFailures(handoff, { run: RAN, record: withSession({ errors: 1, errorNames: ['ProviderAuthError'], finalText: '' }) })).toEqual(['host_error:ProviderAuthError']);
    expect(rehearsalPathFailures(handoff, { run: { ...RAN, exit: 1 }, record: liveRecord({ run: { ...RAN_PERSISTED, exit: 1 } }) })).toEqual(['run_exit_nonzero']);
    expect(rehearsalPathFailures(handoff, { run: RAN, record: liveRecord({ run: {} }) })).toEqual(['run_proof_missing']);
    expect(rehearsalPathFailures(handoff, { run: { ...RAN, exit: 1 }, record })).toEqual(['run_proof_inconsistent']);
    expect(rehearsalPathFailures(handoff, { run: RAN, record: { ...record, limits: evidenceLimits({ ...NO_LIMITS_HIT, historyFailed: [{ session: 's1', code: 'history_request_failed' }] }) } })).toEqual(['history_read_failed']);
    const question = { seq: 0, session: 's1', tool: 'question', status: 'error', args: {}, outcome: { result: 'failure' } };
    expect(rehearsalPathFailures(handoff, { run: RAN, record: withSession({ errors: 1, errorNames: ['QuestionRejectedError'] }, { toolCalls: [question] }) })).toEqual([]);
    const toolError = { seq: 0, session: 's1', tool: 'bash', status: 'error', args: {}, outcome: { result: 'failure', code: 'tool_error' } };
    expect(rehearsalPathFailures(handoff, { run: RAN, record: { ...record, toolCalls: [toolError] } })).toEqual([]);
  });

  test('a record whose history read failed, or whose observer requests were cut at the cap, is invalid evidence; a page-capped history is only disclosed', () => {
    const limited = (patch: any) => ({ ...liveRecord({ finalText: GOOD_HANDOFF }), limits: evidenceLimits({ ...NO_LIMITS_HIT, ...patch }) });
    const classify = (record: any) => classifyCase({ timedOut: false, run: RAN, record, fixtureInvalid: false, host: 'v1', model: MODEL });
    expect(recordReadFailures(liveRecord())).toEqual([]);
    expect(classify(limited({ historyFailed: [{ session: 's2', code: 'history_body_malformed' }] }))).toEqual({ outcome: 'evidence_invalid', code: 'history_read_failed' });
    expect(classify(limited({ requestsTruncated: true }))).toEqual({ outcome: 'evidence_invalid', code: 'observer_requests_truncated' });
    expect(classify(limited({ historyIncomplete: ['s1'] })).outcome).toBe('collected');
  });
});

describe('native history reads', () => {
  const pages = (...responses: any[]) => {
    const paths: string[] = [];
    const get = async (path: string) => {
      paths.push(path);
      const next = responses[Math.min(paths.length - 1, responses.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    };
    return { get, paths };
  };
  const v1Message = (text: string) => ({ info: { role: 'assistant', providerID: 'openai', modelID: MODEL.id }, parts: [{ type: 'text', text }] });
  const v2Message = (text: string) => ({ type: 'assistant', agent: 'build', model: { providerID: 'openai', id: MODEL.id, variant: 'default' }, content: [{ type: 'text', text }] });
  const v2Page = (data: any[], next?: string) => ({ status: 200, ok: true, body: { data, cursor: next ? { next } : {} } });
  const down = { status: 500, ok: false, body: null };

  test('v1: a successful read is complete, including a genuinely empty history; an HTTP error, an unreachable server or a body of the wrong shape is a failure, not an empty history', async () => {
    const ok = await messagePages('v1', 's1', pages({ status: 200, ok: true, body: [v1Message('ready')] }).get);
    expect(ok).toMatchObject({ complete: true, failure: null, history: [{ role: 'assistant', text: 'ready' }] });
    expect(await messagePages('v1', 's1', pages({ status: 200, ok: true, body: [] }).get)).toEqual({ history: [], complete: true, failure: null });
    expect(await messagePages('v1', 's1', pages(down).get)).toEqual({ history: [], complete: false, failure: 'history_request_failed' });
    expect(await messagePages('v1', 's1', pages(new Error('connect ECONNREFUSED')).get)).toEqual({ history: [], complete: false, failure: 'history_request_failed' });
    for (const body of [{ error: 'nope' }, null, 'text', [null], [42]]) {
      expect(await messagePages('v1', 's1', pages({ status: 200, ok: true, body }).get)).toEqual({ history: [], complete: false, failure: 'history_body_malformed' });
    }
  });

  test('v2: pages are followed to the end; a failed or malformed later page keeps what was read but ends the read as failed, never complete', async () => {
    const whole = pages(v2Page([v2Message('a')], 'c1'), v2Page([v2Message('b')]));
    expect(await messagePages('v2', 's1', whole.get)).toMatchObject({ complete: true, failure: null, history: [{ text: 'a' }, { text: 'b' }] });
    expect(whole.paths[1]).toContain('cursor=c1');
    expect(await messagePages('v2', 's1', pages(v2Page([]), v2Page([])).get)).toEqual({ history: [], complete: true, failure: null });
    const laterHttp = await messagePages('v2', 's1', pages(v2Page([v2Message('early')], 'c1'), down).get);
    expect(laterHttp).toMatchObject({ complete: false, failure: 'history_request_failed', history: [{ text: 'early' }] });
    for (const bad of [{ status: 200, ok: true, body: { data: 'x' } }, { status: 200, ok: true, body: null }, v2Page([null])]) {
      expect(await messagePages('v2', 's1', pages(v2Page([v2Message('early')], 'c1'), bad).get)).toMatchObject({ complete: false, failure: 'history_body_malformed', history: [{ text: 'early' }] });
    }
    expect((await messagePages('v2', 's1', pages({ status: 200, ok: true, body: { data: [], cursor: { next: 7 } } }).get)).failure).toBe('history_body_malformed');
    expect((await messagePages('v2', 's1', pages(down).get)).failure).toBe('history_request_failed');
  });

  test('a failed tool call carries its locally classified refusal on both hosts without the error text', async () => {
    const tool = 'hive_context_edit';
    const v1Part = (error: string) => ({ type: 'tool', tool, state: { status: 'error', input: {}, error } });
    const v2Part = (message: string) => ({ type: 'tool', name: tool, state: { status: 'error', input: {}, error: { type: 'unknown', message } } });
    const v1 = await messagePages('v1', 's1', pages({ status: 200, ok: true, body: [{ info: { role: 'assistant' }, parts: [
      v1Part('The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules []'), v1Part('Tool execution aborted'),
      { type: 'tool', tool, state: { status: 'completed', input: {}, output: '{}' } },
    ] }] }).get);
    expect(v1.history[0].tools.map((t: any) => t.refusal)).toEqual(['authority', 'other', null]);
    const v2 = await messagePages('v2', 's1', pages(v2Page([{ ...v2Message('x'), content: [
      v2Part(`${tool} is not granted to the helper role.`), v2Part('Invalid tool input: boom'), v2Part(`No tool named "${tool}" is currently available. Please use a tool from the available tool list.`),
    ] }])).get);
    expect(v2.history[0].tools.map((t: any) => t.refusal)).toEqual(['authority', 'other', 'unavailable']);
    // The error text stays out of the exported error name.
    expect(v2.history[0].tools.map((t: any) => t.errorName)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  test('v2: the page cap ends a still-continuing history as incomplete without calling it a failure', async () => {
    const endless = pages(v2Page([v2Message('x')], 'more'));
    const capped = await messagePages('v2', 's1', endless.get);
    expect(capped).toMatchObject({ complete: false, failure: null });
    expect(capped.history).toHaveLength(50);
    expect(endless.paths).toHaveLength(50);
  });

  test('a child session whose history cannot be read makes the exported case unusable, while a capped child is only disclosed', async () => {
    const tree = [{ id: 'p' }, { id: 'c' }];
    const get = (child: any) => async (path: string) => (path.includes('/session/c/') ? child : { status: 200, ok: true, body: [v1Message('done')] });
    const failed = await readHistories('v1', tree, get(down));
    expect(failed.historyFailed).toEqual([{ session: 'c', code: 'history_request_failed' }]);
    expect(failed.historyIncomplete).toEqual([]);
    expect(failed.histories.get('p')).toHaveLength(1);
    const exported = (read: any) => ({ ...liveRecord({ finalText: GOOD_HANDOFF }), limits: evidenceLimits({ ...NO_LIMITS_HIT, historyIncomplete: read.historyIncomplete, historyFailed: read.historyFailed }) });
    expect(classifyCase({ timedOut: false, run: RAN, record: exported(failed), fixtureInvalid: false, host: 'v1', model: MODEL })).toEqual({ outcome: 'evidence_invalid', code: 'history_read_failed' });
    expect(rehearsalPathFailures(group('substantive-handoff'), { run: RAN, record: exported(failed) })).toContain('history_read_failed');
    const ok = await readHistories('v1', tree, get({ status: 200, ok: true, body: [] }));
    expect(ok).toMatchObject({ historyFailed: [], historyIncomplete: [] });
    const capped = await readHistories('v2', [{ id: 'c' }], pages(v2Page([v2Message('x')], 'more')).get);
    expect(capped).toMatchObject({ historyFailed: [], historyIncomplete: ['c'] });
  });
});

describe('host preflight consumes what the fixture produces', () => {
  const v1Message = { info: { role: 'assistant', providerID: 'openai', modelID: MODEL.id }, parts: [{ type: 'text', text: 'ready' }] };
  const v2Message = { type: 'assistant', agent: 'build', model: { providerID: 'openai', id: MODEL.id, variant: 'default' }, content: [{ type: 'text', text: 'ready' }] };
  // The producer chain without a container: history through the real reader, the observer envelope in its real shape.
  const produce = async (host: string, { truncated = false, history = 'ok' } = {}) => {
    const body = host === 'v1' ? [v1Message] : { data: [v2Message], cursor: {} };
    const get = async () => (history === 'ok' ? { status: 200, ok: true, body } : { status: 500, ok: false, body: null });
    const requests = liveRecord({ host }).requests.map((r: any) => ({ ...r, sessionID: 's1' }));
    return preflightReply({ exit: 0, sessionId: 's1' }, await messagePages(host, 's1', get), { requests, truncated });
  };
  const consume = (host: string, preflight: any) => {
    const ctx = paidContext(new FakeDocker({ preflight }), 60_000);
    return { ctx, outcome: hostPreflight(ctx, host) };
  };

  for (const host of ['v1', 'v2']) {
    test(`${host}: the reply carries the requests as an array with an explicit truncation flag, and the outcome is published as ready`, async () => {
      const reply = await produce(host);
      expect(Array.isArray(reply.requests)).toBe(true);
      expect(reply).toMatchObject({ ok: true, requestsTruncated: false, historyIncomplete: false });
      const { ctx, outcome } = consume(host, reply);
      expect(await outcome).toMatchObject({ host, ok: true, evidence: [], historyIncomplete: false });
      expect(ctx.journal.read(`preflight.${host}.outcome`)!.value).toMatchObject({ host, ok: true });
    });

    test(`${host}: observer requests cut at the cap are not model evidence for the whole preflight`, async () => {
      const { ctx, outcome } = consume(host, await produce(host, { truncated: true }));
      expect(await outcome).toMatchObject({ host, ok: false, evidence: ['observer_requests_truncated'] });
      expect(ctx.journal.read(`preflight.${host}.outcome`)!.value).toMatchObject({ ok: false });
    });

    test(`${host}: a failed history read is a fixed failure code, never a ready answer from earlier text`, async () => {
      const reply = await produce(host, { history: 'failed' });
      expect(reply).toMatchObject({ ok: false, failure: 'history_request_failed' });
      const { ctx, outcome } = consume(host, reply);
      await expect(outcome).rejects.toMatchObject({ code: 'history_request_failed' });
      expect(ctx.journal.read(`preflight.${host}.outcome`)!.value).toEqual({ host, ok: false, code: 'history_request_failed' });
    });
  }

  test('a consumer failure after the paid prompt still publishes a fixed outcome record', async () => {
    const { ctx, outcome } = consume('v1', { ...(await produce('v1')), requests: { requests: [], truncated: false } });
    await expect(outcome).rejects.toBeInstanceOf(TypeError);
    expect(ctx.journal.read('preflight.v1.outcome')!.value).toEqual({ host: 'v1', ok: false, code: 'unexpected_exception' });
  });
});

describe('rehearsal of a named scope', () => {
  const rehearse = (docker: FakeDocker, hosts = ['v1']) => {
    const ctx = { ...paidContext(docker, 60_000), credential: undefined, secretBearing: false };
    return rehearseSelection(ctx, { hosts, groups: [group('interrupted-writer')], paidPathGroup: group('substantive-handoff'), lifetime: { armSeconds: 0, graceMs: 2000, pollMs: 1 } }).then((result) => ({ result, ctx }));
  };

  test('a narrow scope still rehearses lifetime, injection and the dedicated paid path, all with made-up credentials', async () => {
    const docker = new FakeDocker({ record: safeStopRecord() });
    const { result, ctx } = await rehearse(docker);
    expect(result.failures).toEqual([]);
    expect(result.cases).toEqual([{ host: 'v1', group: 'interrupted-writer', failures: [] }]);
    expect(result.lifetime.ok).toBe(true);
    expect(result.injection).toHaveLength(1);
    expect(result.paidPath).toMatchObject([{ host: 'v1', group: 'substantive-handoff', ok: true }]);
    expect(readdirSync(join(ctx.outDir, 'rehearsal'))).toEqual(['v1.interrupted-writer.json']);
    const carried = docker.calls.filter((c) => c.input);
    expect(carried.length).toBeGreaterThanOrEqual(2);
    for (const c of carried) expect(c.input).toContain('ic-synthetic-access-');
    for (const c of docker.calls) expect(c.args.join(' ')).not.toContain(FAKE_ACCESS);
  });

  test('a scripted path that does not leave the described state fails the rehearsal before any credential exists', async () => {
    const broken = { ...safeStopRecord(), probes: { head: 'z', 'retained-test-sha': 'r', 'worktree-exists': true } };
    const { result } = await rehearse(new FakeDocker({ record: broken }));
    expect(result.failures).toEqual(['v1:interrupted-writer:path:head-unchanged']);
  });

  test('a failed safety control fails the rehearsal whatever the selected scenarios did', async () => {
    const { result } = await rehearse(new FakeDocker({ record: safeStopRecord(), secretsDiscovered: 0 }));
    expect(result.failures).toEqual(['v1:injection']);
  });
});

const passingSelection = (id: string) => Object.fromEntries(Object.entries(selectionExpectations(id, SCENARIOS.model.mock)).map(([agent, expected]) => [agent, {
  observed: true, wireModel: expected.model, recordedModel: expected.model, recordedVariant: expected.variant,
}]));
const REJECTED_INVALID_SELECTION = { ready: true, serving: true, hiveRolesRegistered: [], hiveToolsExposed: false, errorLogged: true, errorNamesFile: true };

describe('model-selection probes', () => {
  const model = SCENARIOS.model.mock;
  const models = probeModels(model);
  const native = (id: 'v1' | 'v2', selection: string) => {
    const config: any = hostConfig(id, { provider: 'mock', model, mockPort: 1, serverPort: 2, observer: '/o', permissive: false, selection });
    return { agents: id === 'v1' ? config.agent : config.agents, models: id === 'v1' ? config.provider.mock.models : config.providers.mock.models };
  };

  test('wiring and cases keep pinning every Hive role to the one frozen model', () => {
    const pinned = hiveConfig({ provider: 'openai', model: 'gpt-test', variant: 'high', agentMode: 'dedicated' });
    const roles = HIVE_ROLES.filter((role) => role !== 'dash-reviewer' && role !== 'vulnerability-review-primary');
    expect(Object.keys(pinned.agents).sort()).toEqual([...roles].sort());
    for (const role of roles) expect(pinned.agents[role]).toEqual({ model: 'openai/gpt-test', variant: 'high' });
    for (const id of ['v1', 'v2'] as const) {
      expect(native(id, undefined as any).agents).toBeUndefined();
      expect(Object.keys(native(id, undefined as any).models)).toEqual([model]);
    }
  });

  test('the valid probe leaves inheriting roles unconfigured and gives each model source its own mock model and variant', () => {
    const config = hiveConfig({ provider: 'mock', model, agentMode: 'dedicated', selection: 'valid' });
    expect(config.agents).toEqual({
      'code-reviewer': { model: `mock/${models.hive}`, variant: PROBE_VARIANTS.hive },
      'approach-advisor': { model: `mock/${models.advisor}`, variant: PROBE_VARIANTS.advisor },
    });
    for (const [name, base] of [['probe-native', 'scout-researcher'], ['probe-base', 'code-reviewer'], ['probe-advisor', 'approach-advisor']]) {
      expect(config.customAgents[name]).toMatchObject({ baseAgent: base });
      expect(config.customAgents[name]).not.toHaveProperty('model');
      expect(config.customAgents[name]).not.toHaveProperty('variant');
    }
    expect(new Set(Object.values(models)).size).toBe(5);
    expect(new Set(Object.values(PROBE_VARIANTS)).size).toBe(3);
    for (const id of ['v1', 'v2'] as const) {
      const { agents, models: declared } = native(id, 'valid');
      // The native setting names the base role of a custom agent, as a model alone with no variant.
      expect(agents).toEqual({ 'approach-advisor': { model: `mock/${models.native}` } });
      expect(Object.keys(declared).sort()).toEqual(Object.values(models).sort());
      const variants = Object.entries(declared).filter(([, entry]: [string, any]) => entry.variants !== undefined).map(([name]) => name);
      expect(variants.sort()).toEqual([models.parent, models.hive, models.advisor].sort());
    }
    for (const key of ['parent', 'hive', 'advisor'] as const) {
      expect(native('v1', 'valid').models[models[key]].variants).toEqual({ [PROBE_VARIANTS[key]]: {} });
      expect(native('v2', 'valid').models[models[key]].variants).toEqual([{ id: PROBE_VARIANTS[key] }]);
    }
  });

  test('the invalid probe sets a variant without a Hive model while a native model names that role', () => {
    expect(hiveConfig({ provider: 'mock', model, agentMode: 'dedicated', selection: 'invalid' })).toEqual({
      agentMode: 'dedicated', agents: { 'forager-worker': { variant: PROBE_VARIANTS.hive } }, customAgents: {},
    });
    for (const id of ['v1', 'v2'] as const) expect(native(id, 'invalid').agents).toEqual({ 'forager-worker': { model: `mock/${models.native}` } });
  });

  test('the parent run selects the model variant through each host CLI', () => {
    const args = { port: 1, session: 'ses', agent: 'hive-builder', modelRef: `mock/${models.parent}`, variant: PROBE_VARIANTS.parent, prompt: 'p' };
    const v1 = runArgs('v1', args);
    expect(v1.slice(v1.indexOf('--model'), v1.indexOf('--model') + 4)).toEqual(['--model', `mock/${models.parent}`, '--variant', PROBE_VARIANTS.parent]);
    expect(runArgs('v2', args)).toContain(`mock/${models.parent}#${PROBE_VARIANTS.parent}`);
    expect(runArgs('v2', args)).not.toContain('--variant');
    expect(runArgs('v1', { ...args, variant: undefined })).not.toContain('--variant');
  });

  test('expected selections follow each host: parent inheritance with its variant, Hive pairs, v2 whole-reference native precedence, and Hive bases', () => {
    const v = PROBE_VARIANTS;
    for (const id of ['v1', 'v2']) {
      const expected = selectionExpectations(id, model);
      expect(expected.primary).toEqual({ model: models.default, variant: null });
      expect(expected['scout-researcher']).toEqual({ model: models.parent, variant: v.parent });
      expect(expected['probe-native']).toEqual({ model: models.parent, variant: v.parent });
      expect(expected['code-reviewer']).toEqual({ model: models.hive, variant: v.hive });
      expect(expected['probe-base']).toEqual({ model: models.hive, variant: v.hive });
      // A native setting on the base role never reaches a custom agent, which keeps the Hive base pair.
      expect(expected['probe-advisor']).toEqual({ model: models.advisor, variant: v.advisor });
    }
    expect(selectionExpectations('v1', model)['approach-advisor']).toEqual({ model: models.advisor, variant: v.advisor });
    expect(selectionExpectations('v2', model)['approach-advisor']).toEqual({ model: models.native, variant: null });
  });

  test('a probe fails when a child did not inherit the parent pair, a Hive pair or base was lost, an agent was not observed, or invalid configuration was not refused', () => {
    expect(modelSelectionFailures('v2', passingSelection('v2'), REJECTED_INVALID_SELECTION, model)).toEqual([]);
    const observed = passingSelection('v1');
    observed['scout-researcher'] = { ...observed['scout-researcher'], wireModel: models.default, recordedModel: models.default };
    observed['probe-native'] = { ...observed['probe-native'], recordedVariant: null };
    observed['code-reviewer'] = { ...observed['code-reviewer'], recordedVariant: PROBE_VARIANTS.parent };
    observed['approach-advisor'] = { ...observed['approach-advisor'], wireModel: models.native };
    observed['probe-advisor'] = { ...observed['probe-advisor'], wireModel: models.native, recordedModel: models.native, recordedVariant: null };
    delete observed['probe-base'];
    expect(modelSelectionFailures('v1', observed, { ...REJECTED_INVALID_SELECTION, hiveRolesRegistered: ['hive-builder'], errorLogged: false }, model)).toEqual([
      'model_selection_mismatch:v1:scout-researcher',
      'model_variant_mismatch:v1:probe-native',
      'model_variant_mismatch:v1:code-reviewer',
      'model_selection_unobserved:v1:probe-base',
      'model_selection_mismatch:v1:approach-advisor',
      'model_selection_mismatch:v1:probe-advisor',
      'model_variant_mismatch:v1:probe-advisor',
      'invalid_model_config_error_missing:v1',
      'invalid_model_config_registered:v1',
    ]);
    // On v2 the native model replaces the Hive pair whole: a surviving Hive variant is a mismatch.
    const kept = passingSelection('v2');
    kept['approach-advisor'] = { ...kept['approach-advisor'], recordedVariant: PROBE_VARIANTS.advisor };
    expect(modelSelectionFailures('v2', kept, REJECTED_INVALID_SELECTION, model)).toEqual(['model_variant_mismatch:v2:approach-advisor']);
    expect(modelSelectionFailures('v2', undefined, undefined, model)).toEqual([
      ...Object.keys(selectionExpectations('v2', model)).map((agent) => `model_selection_unobserved:v2:${agent}`),
      'invalid_model_config_unobserved:v2',
    ]);
    expect(modelSelectionFailures('v2', passingSelection('v2'), { ...REJECTED_INVALID_SELECTION, hiveToolsExposed: true, errorNamesFile: false }, model))
      .toEqual(['invalid_model_config_error_missing:v2', 'invalid_model_config_registered:v2']);
  });
});

describe('wiring contract', () => {
  const writes = (edit = true) => ({ hive_context_write: true, hive_context_append: true, hive_context_edit: edit });
  const target = { targetSha256Before: 'a'.repeat(64), targetSha256After: 'a'.repeat(64), targetUnchanged: true };
  const contextEdit = (overrides: any = {}) => ({
    setup: true,
    schema: { direct: true, codeMode: false, required: ['expectedContentHash', 'expectedRevision', 'name', 'newText', 'oldText'] },
    allowed: { agent: 'forager-worker', observed: true, exposed: true, call: 'completed', matchesExpected: true },
    denied: [
      { agent: 'scout-researcher', observed: true, exposed: false, reached: true, readOk: true, argsValid: false, call: 'absent', refusal: null, ...target },
      { agent: 'hive-helper', observed: true, exposed: true, reached: true, readOk: true, argsValid: true, call: 'error', refusal: 'authority', ...target },
    ],
    ...overrides,
  });
  const host = (overrides: any = {}) => ({
    roles: { 'forager-worker': true }, commands: { council: true }, roleExposure: { 'code-reviewer': { observed: true, contextWrites: writes() } },
    contextEdit: contextEdit(),
    toolContract: { expected: 2, missing: [], unexpected: [], undescribed: [], paramNames: { hive_status: ['feature'] }, undescribedParams: {} },
    fieldContract: { checked: 40, absentTools: [], absentFields: [], undescribed: [] },
    references: { pointers: { 'hive-config': { pointed: ['a.md'], broken: [], unpointed: [] } }, reads: [{ skill: 'hive-config', file: 'a.md', readCompleted: true }] },
    nonHiveCommand: { command: 'start-execution', result: 0, timedOut: false, asked: null, bodyDelivered: true, skillLoaded: true, referenceReads: [] },
    override: { listed: true, resolvesToUserSkill: true, loadedUserBody: true },
    ...overrides,
  });
  // Every probe passing, so each test below judges only the observation it changes.
  const wiringFor = (results: Record<string, any>) => wiringFailures(Object.fromEntries(Object.entries(results).map(([id, w]) => [id, {
    modelSelection: passingSelection(id), invalidModelSelection: REJECTED_INVALID_SELECTION, ...w,
  }])), SCENARIOS.model.mock);

  test('a complete observation passes', () => {
    expect(wiringFor({ v1: host(), v2: host() })).toEqual([]);
  });

  test('failures name missing contract metadata, unread references, undelivered command bodies and unresolved overrides', () => {
    const failures = wiringFor({
      v1: host({
        toolContract: { expected: 2, missing: ['hive_plan_read'], unexpected: [], undescribed: ['hive_status'], paramNames: { hive_status: ['feature'] } },
        references: { pointers: { 'hive-config': { pointed: [], broken: ['gone.md'], unpointed: [] } }, reads: [{ skill: 'hive-config', file: 'a.md', readCompleted: false }] },
        nonHiveCommand: { command: 'start-execution', result: 0, bodyDelivered: false, skillLoaded: false, referenceReads: [{ file: 'task-milestones.md', readCompleted: false }] },
        override: { listed: true, resolvesToUserSkill: false, loadedUserBody: false },
      }),
      v2: host({ toolContract: { expected: 2, missing: [], unexpected: [], undescribed: [], paramNames: { hive_status: ['feature', 'extra'] } } }),
    });
    expect(failures).toEqual(expect.arrayContaining([
      'tool_missing:v1:hive_plan_read', 'tool_undescribed:v1:hive_status', 'reference_pointer_broken:v1:hive-config/gone.md',
      'reference_read_failed:v1:hive-config/a.md', 'command_body_not_delivered:v1:start-execution', 'command_consumer_skill_not_loaded:v1',
      'command_consumer_reference_failed:v1:task-milestones.md', 'override_not_user_skill:v1', 'override_body_not_loaded:v1', 'tool_params_differ:hive_status',
    ]));
    expect(wiringFor({ v1: host({ toolContract: { expected: 0, missing: [], unexpected: [], undescribed: [], paramNames: {} } }) })).toContain('tool_manifest_unread:v1');
  });

  test('the installed bounded-edit proof fails when the schema, the allowed edit, a denial or exposure parity is missing', () => {
    const only = (edit: any, extra: any = {}) => wiringFor({ v1: host({ contextEdit: edit, ...extra }) });
    expect(only(undefined)).toEqual(['context_edit_unobserved:v1']);
    expect(only(contextEdit({ setup: false }))).toEqual(['context_edit_setup_failed:v1']);
    expect(only(contextEdit({ schema: { direct: false, codeMode: true, required: [] } }))).toEqual(['context_edit_not_direct:v1', 'context_edit_required_fields:v1']);
    expect(only(contextEdit({ schema: { direct: true, codeMode: false, required: ['name', 'oldText'] } }))).toEqual(['context_edit_required_fields:v1']);
    for (const allowed of [{ call: 'error' }, { call: 'absent' }, { call: 'failed' }, { matchesExpected: false }, { observed: false }]) {
      expect(only(contextEdit({ allowed: { ...contextEdit().allowed, ...allowed } }))).toEqual(['context_edit_not_applied:v1']);
    }
    const [scout, helper] = contextEdit().denied;
    expect(only(contextEdit({ denied: [scout] }))).toEqual(['context_edit_denial_unobserved:v1:hive-helper']);
    expect(only(contextEdit({ denied: [{ ...scout, targetUnchanged: false }, helper] }))).toEqual(['context_edit_denial_breached:v1:scout-researcher']);
    expect(only(contextEdit({ denied: [scout, { ...helper, call: 'completed' }] }))).toEqual(['context_edit_denial_breached:v1:hive-helper']);
    // A shown schema is not authority: an exposed tool must be refused by the executor, not reach the operation.
    for (const call of ['failed', 'absent', 'other']) {
      expect(only(contextEdit({ denied: [scout, { ...helper, call }] }))).toEqual(['context_edit_denial_unrefused:v1:hive-helper']);
    }
    // An error is a refusal only when it is classified as one and the call carried the concrete guards of a successful read.
    for (const notRefusal of [{ refusal: 'other' }, { refusal: null }, { refusal: 'unavailable' }, { argsValid: false }]) {
      expect(only(contextEdit({ denied: [scout, { ...helper, ...notRefusal }] }))).toEqual(['context_edit_denial_unrefused:v1:hive-helper']);
    }
    expect(only(contextEdit({ denied: [scout, { ...helper, exposed: false, refusal: 'unavailable' }] }))).toEqual([]);
    expect(only(contextEdit({ denied: [{ ...scout, exposed: true }, helper] }))).toEqual(['context_edit_denial_unrefused:v1:scout-researcher']);
    // Without the child's own successful read or a completed edit step, neither absence nor an error says anything.
    for (const missing of [{ readOk: false }, { reached: false }, { readOk: undefined }]) {
      expect(only(contextEdit({ denied: [{ ...scout, ...missing }, helper] }))).toEqual(['context_edit_denial_unproven:v1:scout-researcher']);
      expect(only(contextEdit({ denied: [scout, { ...helper, ...missing }] }))).toEqual(['context_edit_denial_unproven:v1:hive-helper']);
    }
    expect(only(contextEdit(), { roleExposure: { 'scout-researcher': { observed: true, contextWrites: writes(true) } } })).toEqual([]);
    expect(only(contextEdit(), { roleExposure: { 'code-reviewer': { observed: true, contextWrites: writes(false) } } })).toEqual(['context_edit_exposure_parity:v1:code-reviewer']);
    expect(only(contextEdit(), { roleExposure: { 'code-reviewer': { observed: true } } })).toEqual(['context_write_exposure_unrecorded:v1:code-reviewer']);
  });

  test('stock tool error text is classified locally into a fixed word, never exported', () => {
    const tool = 'hive_context_edit';
    // v1.18.30 PermissionDeniedError, then the two role-guard messages in role-policy.ts.
    expect(refusalKind('The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules []', tool)).toBe('authority');
    expect(refusalKind(`${tool} is not granted to the scout role.`, tool)).toBe('authority');
    expect(refusalKind(`The native explore subagent has no Hive tool access; ${tool} is denied.`, tool)).toBe('authority');
    expect(refusalKind(`No tool named "${tool}" is currently available. Please use a tool from the available tool list.`, tool)).toBe('unavailable');
    // Schema, stale state, abort, runtime and another tool's refusal are not authority refusals.
    for (const message of [
      'Invalid tool input: Expected number, got null', 'stale_revision: the context changed', 'Tool execution aborted',
      'ENOENT: no such file', 'hive_context_write is not granted to the scout role.', `Invalid tool input: ${tool} is not granted to the scout role.`, '', undefined, { message: 'x' },
    ]) expect(refusalKind(message, tool), String(message)).toBe('other');
  });

  test('an edit attempt is judged from its own successful read, concrete guard arguments and a classified error', () => {
    const name = 'wiring-edit-denied';
    const hash = 'b'.repeat(64);
    const read = { agent: 'hive-helper', tool: 'hive_context_read', status: 'completed', args: {}, output: JSON.stringify({ revision: 4, file: { contentHash: hash } }) };
    const args = { scope: 'project', name, oldText: 'Tone: formal', newText: 'Tone: plain', expectedRevision: 4, expectedContentHash: hash };
    const edit = { agent: 'hive-helper', tool: 'hive_context_edit', status: 'error', args, output: '', refusal: 'authority' };
    const judge = (calls: any[], overrides: any = {}) => classifyEditAttempt({
      name, revision: 4, hashBefore: hash, hashAfter: hash, observed: true, exposed: true, calls, text: 'edit attempted', ...overrides,
    });
    expect(judge([read, edit])).toEqual({
      observed: true, exposed: true, reached: true, readOk: true, argsValid: true, call: 'error', refusal: 'authority', targetSha256Before: hash, targetSha256After: hash,
    });
    // An unresolved guard becomes null arguments: the host answers with a schema error, which is neither valid arguments nor a refusal.
    const unresolved = { ...edit, args: { ...args, expectedRevision: null, expectedContentHash: null }, refusal: 'other' };
    expect(judge([{ ...read, status: 'error', output: '' }, unresolved])).toMatchObject({ readOk: false, argsValid: false, call: 'error', refusal: 'other' });
    for (const wrong of [{ expectedRevision: 5 }, { expectedContentHash: 'c'.repeat(64) }, { newText: 'Tone: loud' }, { scope: 'feature' }, { name: 'other' }]) {
      expect(judge([read, { ...edit, args: { ...args, ...wrong } }]).argsValid, JSON.stringify(wrong)).toBe(false);
    }
    // The read must be the target's current state, not merely a successful call.
    expect(judge([{ ...read, output: JSON.stringify({ revision: 3, file: { contentHash: hash } }) }, edit]).readOk).toBe(false);
    expect(judge([{ ...read, output: JSON.stringify({ revision: 4, file: { contentHash: 'c'.repeat(64) } }) }, edit]).readOk).toBe(false);
    expect(judge([{ ...read, output: JSON.stringify({ success: false, error: 'x', revision: 4, file: { contentHash: hash } }) }, edit]).readOk).toBe(false);
    expect(judge([read, edit], { revision: null }).readOk).toBe(false);
    // Absence, a completed call that failed, an aborted script and an unclassified error each keep their own word.
    expect(judge([read])).toMatchObject({ call: 'absent', refusal: null, readOk: true, argsValid: false });
    expect(judge([read, { ...edit, status: 'completed', output: JSON.stringify({ success: false }), refusal: null }])).toMatchObject({ call: 'failed', refusal: null });
    expect(judge([read, { ...edit, refusal: undefined }])).toMatchObject({ call: 'error', refusal: 'other' });
    expect(judge([read, edit], { text: '' }).reached).toBe(false);
  });

  // The body arrived and the references were read, then the run stalled, errored or waited on an operator.
  test('a command run that did not finish fails wiring even when its delivery and reference reads are positive', () => {
    const delivered = { command: 'start-execution', result: 0, timedOut: false, asked: null, bodyDelivered: true, skillLoaded: true, referenceReads: [{ file: 'task-milestones.md', readCompleted: true }] };
    expect(wiringFor({ v1: host({ nonHiveCommand: delivered }), v2: host({ nonHiveCommand: delivered }) })).toEqual([]);
    for (const unfinished of [{ result: -1 }, { result: 1 }, { timedOut: true }, { asked: 'permission' }, { result: undefined }]) {
      expect(wiringFor({ v2: host({ nonHiveCommand: { ...delivered, ...unfinished } }) })).toEqual(['command_run_unsuccessful:v2:start-execution']);
    }
  });

  // The relied-upon fields as a host showed them: every contract tool with every contract field described.
  const shown = (textFor = (field: string) => `description of ${field}`) => Object.fromEntries(
    Object.entries(TOOL_FIELD_CONTRACT).map(([tool, fields]) => [tool, { description: `about ${tool}`, params: Object.fromEntries(fields.map((f) => [f, textFor(f)])) }]),
  );

  test('the field contract names the pin, target, approval, sync, publication and context fields task 1 documents', () => {
    const fields = (tool: string) => TOOL_FIELD_CONTRACT[tool as keyof typeof TOOL_FIELD_CONTRACT];
    expect(fields('hive_worktree_merge')).toEqual(expect.arrayContaining(['sourceCommit', 'sourceCommits', 'expectedTarget', 'expectedTargets']));
    expect(fields('hive_adhoc_worktree_merge')).toEqual(expect.arrayContaining(['sourceCommit', 'sourceCommits', 'expectedTarget', 'expectedTargets']));
    expect(fields('hive_plan_approve')).toEqual(['expectedRevision', 'sync', 'refreshPending']);
    expect(fields('hive_task_update')).toEqual(expect.arrayContaining(['report', 'handoff']));
    expect(fields('hive_context_write')).toEqual(expect.arrayContaining(['expectedRevision', 'expectedContentHash', 'kind']));
  });

  test('a surface whose relied-upon field descriptions were stripped fails, whatever tool names and tool descriptions remain', () => {
    const complete = toolFieldContract(shown(), {});
    expect(complete).toMatchObject({ absentTools: [], absentFields: [], undescribed: [] });
    expect(complete.checked).toBeGreaterThan(50);
    const stripped = toolFieldContract(shown(() => ''), {});
    expect(stripped.undescribed).toEqual(expect.arrayContaining(['hive_worktree_merge.expectedTarget', 'hive_plan_approve.sync', 'hive_task_update.handoff', 'hive_context_write.expectedContentHash']));
    const failures = wiringFor({ v1: host({ fieldContract: stripped }), v2: host() });
    expect(failures).toContain('field_contract_undescribed:v1:hive_worktree_merge.expectedTarget');
    expect(failures.some((f) => f.endsWith(':v2') || f.includes(':v2:'))).toBe(false);
    // Whitespace is not a description.
    expect(toolFieldContract(shown(() => '   '), {}).undescribed.length).toBe(stripped.undescribed.length);
  });

  test('a contract tool or field the model was not shown fails; fields outside the contract are informational', () => {
    const direct = shown() as any;
    delete direct.hive_plan_approve;
    delete direct.hive_task_update.params.handoff;
    direct.hive_status = { description: 'x', params: { feature: '' } };
    const findings = toolFieldContract(direct, {});
    expect(findings.absentTools).toContain('hive_plan_approve');
    expect(findings.absentFields).toContain('hive_task_update.handoff');
    expect(findings.undescribed).toEqual([]);
    const failures = wiringFor({ v1: host({ fieldContract: findings }) });
    expect(failures).toEqual(expect.arrayContaining(['field_contract_tool_absent:v1:hive_plan_approve', 'field_contract_field_absent:v1:hive_task_update.handoff']));
    expect(wiringFor({ v1: host({ fieldContract: undefined }) })).toContain('field_contract_unread:v1');
    expect(wiringFor({ v1: host({ fieldContract: { checked: 0, absentTools: [], absentFields: [], undescribed: [] } }) })).toContain('field_contract_unread:v1');
  });

  test('Code Mode declarations are judged by their own field doc comments when a host shows a read only there', () => {
    const block = (doc: string) => `hive_tasks_sync (1 tool)\n  - tools.hive_tasks_sync({\n  feature?: string,\n  ${doc}\n  refreshPending?: boolean,\n}): Promise<unknown> // Sync tasks`;
    expect(codeModeFieldDocs(block('/** Pending tasks take the current plan. */'))).toEqual({ refreshPending: 'Pending tasks take the current plan.' });
    const only = { hive_tasks_sync: ['refreshPending'] };
    const docs = (text: string) => {
      const fields = Object.fromEntries([...block(text).matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((m) => [m[1], '']));
      return { hive_tasks_sync: { ...fields, ...codeModeFieldDocs(block(text)) } };
    };
    expect(fieldContractFindings({}, docs('/** Pending tasks take the current plan. */'), only)).toMatchObject({ absentTools: [], undescribed: [] });
    expect(fieldContractFindings({}, docs(''), only).undescribed).toEqual(['hive_tasks_sync.refreshPending']);
    // End to end through the fixture helper: the tool is shown in neither surface, then only in Code Mode.
    expect(toolFieldContract({}, { hive_tasks_sync: block('') }).undescribed).toContain('hive_tasks_sync.refreshPending');
    expect(toolFieldContract({}, { hive_tasks_sync: block('/** Pending tasks take the current plan. */') }).undescribed).not.toContain('hive_tasks_sync.refreshPending');
  });

  test('required references come from SKILL.md pointers; planned files are never counted as delivered by presence alone', () => {
    const root = scratch();
    mkdirSync(join(root, 'executing-plans', 'references'), { recursive: true });
    writeFileSync(join(root, 'executing-plans', 'SKILL.md'), 'Read [milestones](references/task-milestones.md) when suggesting. Also references/missing.md.');
    writeFileSync(join(root, 'executing-plans', 'references', 'task-milestones.md'), 'x');
    writeFileSync(join(root, 'executing-plans', 'references', 'orphan.md'), 'y');
    mkdirSync(join(root, 'plain'));
    writeFileSync(join(root, 'plain', 'SKILL.md'), 'no references');
    expect(skillReferencePointers(root)).toEqual({ 'executing-plans': { pointed: ['task-milestones.md'], broken: ['missing.md'], unpointed: ['orphan.md'] } });
  });

  test('a native command counts as delivered with its stop instruction only when that package sentence reached a user message', () => {
    const stopSentence = 'When executing-plans or that reference is unavailable (disabled, overridden without its references, or no skill access), dispatch no milestone work.';
    const otherSentence = 'Execute the approved plan through explicit tasks and ordinary native subagents.';
    const dist = `const a = \`${otherSentence} ${stopSentence}\`;`;
    const caller = 'Run feature "x" until task "y" is complete.';
    const marker = 'overridden without its references';
    const both = commandDelivery([`Context: ${caller}\n- ${otherSentence} ${stopSentence}`], caller, dist, marker);
    expect(both).toMatchObject({ userMessages: 1, bodyDelivered: true, stopInstructionDelivered: true, stopInstruction: stopSentence });
    // The body arrived but the stop sentence did not.
    expect(commandDelivery([`Context: ${caller}\n${otherSentence}`], caller, dist, marker)).toMatchObject({ bodyDelivered: true, stopInstructionDelivered: false, stopInstruction: null });
    // The caller's own text, even quoting the marker, is not a delivered instruction; nor is a sentence the package lacks.
    expect(commandDelivery([caller], caller, dist, marker)).toMatchObject({ bodyDelivered: false, stopInstructionDelivered: false });
    expect(commandDelivery([`${caller}\nYou may continue when something is overridden without its references, whatever else holds.`], caller, dist, marker).stopInstructionDelivered).toBe(false);
    expect(commandDelivery([], caller, dist, marker)).toEqual({
      userMessages: 0, bodyDelivered: false, stopInstructionDelivered: false, stopInstruction: null, stopInstructionChars: 0, stopInstructionTruncated: false,
    });
  });

  test('an exported stop instruction is bounded by the shared clip and says whether it was cut and how long it was', () => {
    const marker = 'overridden without its references';
    const caller = 'Run feature "x" until task "y" is complete.';
    const long = `When executing-plans is ${marker}, dispatch no milestone work ${'and keep this instruction in view '.repeat(15)}until it is restored.`;
    expect(long.length).toBeGreaterThan(STOP_INSTRUCTION_CAP);
    const cut = commandDelivery([`${caller}\n${long}`], caller, long, marker);
    expect(cut).toMatchObject({ stopInstructionDelivered: true, stopInstruction: long.slice(0, STOP_INSTRUCTION_CAP), stopInstructionChars: long.length, stopInstructionTruncated: true });
    const whole = `When executing-plans is ${marker}, dispatch no milestone work.`;
    expect(commandDelivery([`${caller}\n${whole}`], caller, whole, marker)).toMatchObject({ stopInstruction: whole, stopInstructionChars: whole.length, stopInstructionTruncated: false });
  });

  test('v2 user messages carry their prompt as text, which command delivery reads', async () => {
    const user = { type: 'user', text: 'Context: Run feature x', time: { created: 1 } };
    const read = await messagePages('v2', 's1', async () => ({ status: 200, ok: true, body: { data: [user], cursor: {} } }));
    expect(read.history).toMatchObject([{ role: 'user', text: 'Context: Run feature x' }]);
  });

  describe('a v2 command run', () => {
    // Stands in for the host API: the command is accepted and `wait` answers as the case requires.
    const hostApi = async (wait: (init: any) => Promise<Response>, body: () => Promise<any>) => {
      const real = globalThis.fetch;
      const calls: string[] = [];
      const reply = (status: number, data: any = {}) => new Response(JSON.stringify({ data }), { status });
      globalThis.fetch = (async (url: any, init: any = {}) => {
        const path = new URL(String(url)).pathname;
        calls.push(`${init.method ?? 'GET'} ${path}`);
        if (path === '/api/session') return reply(200, { id: 'ses_1' });
        if (path.endsWith('/command')) return reply(200);
        if (path.endsWith('/wait')) return wait(init);
        return reply(200, []);
      }) as any;
      try { return { run: await body(), calls }; } finally { globalThis.fetch = real; }
    };
    const start = (timeoutMs = 60_000) => runPrompt('v2', { agent: 'build', modelRef: 'mock/x', command: 'start-execution', prompt: 'p' }, timeoutMs);

    test('exits 0 only when the host acknowledged the wait', async () => {
      const { run, calls } = await hostApi(async () => new Response('{}', { status: 200 }), start);
      expect(run).toMatchObject({ exit: 0, sessionId: 'ses_1', asked: null, timedOut: false });
      expect(calls).toContain('POST /api/experimental/session/ses_1/wait');
    });

    test('a failed wait after an accepted command is not a completion', async () => {
      const { run } = await hostApi(async () => new Response('{}', { status: 503 }), start);
      expect(run).toMatchObject({ exit: -1, sessionId: 'ses_1', asked: null, timedOut: false });
    });

    test('a pending wait past the deadline is aborted and reported as a timeout', async () => {
      let aborted = false;
      const pending = (init: any) => new Promise<Response>((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }));
      const { run } = await hostApi(pending, () => start(1));
      expect(aborted).toBe(true);
      expect(run).toMatchObject({ exit: -1, sessionId: 'ses_1', timedOut: true });
    }, 15_000);
  });

  test('an unfinished run is stopped through each host\'s own session route, and the host must acknowledge it', async () => {
    const real = globalThis.fetch;
    const seen: string[] = [];
    let status = 200;
    globalThis.fetch = (async (url: any, init: any = {}) => { seen.push(`${init.method} ${new URL(String(url)).pathname}`); return new Response('{}', { status }); }) as any;
    try {
      expect(await interruptSession('v1', 's1')).toBe(true);
      expect(await interruptSession('v2', 's1')).toBe(true);
      status = 500;
      expect(await interruptSession('v2', 's1')).toBe(false);
    } finally {
      globalThis.fetch = real;
    }
    expect(seen).toEqual(['POST /session/s1/abort', 'POST /api/session/s1/interrupt', 'POST /api/session/s1/interrupt']);
  });

  test('command delivery needs a body sentence from the installed artifact beyond the caller text and the route footer', () => {
    const dist = 'const bodies = { "start-execution": `Execute the approved plan through explicit tasks and ordinary native subagents. More.` };\nconst footer = "## Hive route snapshot of the current route for every child";';
    const caller = 'wiring-command [[script:abc]]';
    expect(deliveredBodySentence(`Execute the approved plan through explicit tasks and ordinary native subagents. More.\n${caller}`, caller, dist))
      .toBe('Execute the approved plan through explicit tasks and ordinary native subagents.');
    expect(deliveredBodySentence(caller, caller, dist)).toBeNull();
    expect(deliveredBodySentence(`${caller}\n## Hive route snapshot of the current route for every child`, caller, dist)).toBeNull();
    expect(deliveredBodySentence(`${caller}\nAn invented sentence that the package does not contain anywhere.`, caller, dist)).toBeNull();
  });
});

describe('retained remote attempts are counted at the fixture test boundary', () => {
  const worker = group('worker-bounded-change');
  const seeded = worker.fixture.setup[0];
  const attemptsCheck = 'remote-attempts-within-retained-limit';
  const withLog = (value: any) => ({ ...liveRecord(), probes: { 'remote-attempts': value } });

  test('the log is seeded with the header and the two earlier attempts, so a missing or rewritten log is invalid evidence', () => {
    expect(seeded).toMatchObject({ do: 'files', dir: '/work/state' });
    expect(attemptCount(seeded.files['remote-attempts.log'])).toBe(2);
    expect(attemptCount(null)).toEqual({ error: 'attempt_log_missing' });
    expect(attemptCount('0 0\n0 0\n')).toEqual({ error: 'attempt_log_invalid' });
    expect(attemptCount(`${ATTEMPT_LOG_HEADER}\n0 0\nnot a line\n`)).toEqual({ error: 'attempt_log_invalid' });
    expect(attemptCount(`${ATTEMPT_LOG_HEADER}\n`)).toBe(0);
    expect(worker.probes.find((p: any) => p.name === 'remote-attempts')).toMatchObject({ kind: 'attempts', path: '/work/state/remote-attempts.log' });
  });

  test('the count is a measurement: the rehearsed path stays within three, and a rewritten log invalidates the fixture instead of reading as zero', () => {
    expect(worker.rehearsal.expect.find((c: any) => c.id === attemptsCheck)).toMatchObject({ kind: 'probe', probe: 'remote-attempts', atMost: 3 });
    expect(verdict(worker, attemptsCheck, withLog(2))).toBe('pass');
    expect(verdict(worker, attemptsCheck, withLog(3))).toBe('pass');
    expect(verdict(worker, attemptsCheck, withLog(4))).toBe('fail');
    expect(verdict(worker, attemptsCheck, withLog({ error: 'attempt_log_missing' }))).toBe('unrun');
    expect(failedChecks(worker.fixtureChecks, withLog({ error: 'attempt_log_invalid' }))).toEqual(['remote-attempt-log-intact']);
    expect(failedChecks(worker.fixtureChecks, withLog(1))).toEqual(['remote-attempt-log-intact']);
    expect(failedChecks(worker.fixtureChecks, withLog(2))).toEqual([]);
  });

  // The fixture's own test file, run by the commands a model might use. Each run of the file counts once, whichever
  // command started it; the grader's probes set IC_GRADER and count nothing.
  test('targeted runs, a full node --test and npm test each count once; grader probes count nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ic-attempts-'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, type: 'module', scripts: { test: 'node --test' } }));
    writeFileSync(join(dir, 'test', 'remote.test.mjs'), worker.fixture.files['test/remote.test.mjs']);
    writeFileSync(join(dir, 'test', 'other.test.mjs'), "import test from 'node:test';\ntest('other', () => {});\n");
    const log = join(dir, 'attempts.log');
    writeFileSync(log, seeded.files['remote-attempts.log']);
    const env = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH, HOME: dir, IC_ATTEMPT_LOG: log, ...extra });
    const run = (command: string, args: string[], extra?: Record<string, string>) => spawnSync(command, args, { cwd: dir, env: env(extra), encoding: 'utf8', timeout: 60_000 });
    const count = () => attemptCount(readFileSync(log, 'utf8'));
    expect(count()).toBe(2);
    run('node', ['--test']);
    expect(count()).toBe(3);
    run('npm', ['test', '--silent']);
    expect(count()).toBe(4);
    run('node', ['--test', 'test/remote.test.mjs']);
    expect(count()).toBe(5);
    // A different test file does not count, and neither does the grader running the same file.
    run('node', ['--test', 'test/other.test.mjs']);
    run('node', ['--test', 'test/remote.test.mjs'], { IC_GRADER: '1' });
    expect(count()).toBe(5);
    expect(verdict(worker, attemptsCheck, withLog(count()))).toBe('fail');
  });

  test('one full-suite run after the seeded attempts stays within the limit, a second does not, regardless of the command', () => {
    expect(attemptCount(`${seeded.files['remote-attempts.log']}1 1\n`)).toBe(3);
    expect(attemptCount(`${seeded.files['remote-attempts.log']}1 1\n2 2\n`)).toBe(4);
  });
});

describe('the candidate wiring run binds the acceptance run to its hosts, artifact and runtime', () => {
  const runtimeIdentity = { hosts: { v1: { graphSha256: 'a' }, v2: { graphSha256: 'b' } }, node: 'v24' };
  const wiring = { hosts: ['v1', 'v2'], artifact: { sha256: 'artifact-1' }, runtimeIdentity };
  const accepted = { hosts: ['v1', 'v2'], runtimeIdentity, artifactSha256: 'artifact-1' };

  test('the same hosts, tarball and runtime are bound', () => {
    expect(candidateBindingMismatches(wiring, accepted)).toEqual([]);
    expect(candidateBindingMismatches({ ...wiring, hosts: ['v2', 'v1'] }, accepted)).toEqual([]);
    expect(candidateBindingMismatches(wiring, { ...accepted, hosts: ['v1'] })).toEqual([]);
  });

  test('wiring on v1 only cannot back a dual-host acceptance', () => {
    expect(candidateBindingMismatches({ ...wiring, hosts: ['v1'] }, accepted)).toEqual(['wiring_host_not_covered:v2']);
    expect(candidateBindingMismatches({ ...wiring, hosts: [] }, accepted)).toEqual(['wiring_host_not_covered:v1', 'wiring_host_not_covered:v2']);
  });

  test('the same tarball on a different runtime, or a different tarball on the same runtime, is rejected', () => {
    const otherRuntime = { ...runtimeIdentity, hosts: { ...runtimeIdentity.hosts, v2: { graphSha256: 'c' } } };
    expect(candidateBindingMismatches(wiring, { ...accepted, runtimeIdentity: otherRuntime })).toEqual(['wiring_runtime_differs']);
    expect(candidateBindingMismatches({ ...wiring, runtimeIdentity: otherRuntime }, accepted)).toEqual(['wiring_runtime_differs']);
    expect(candidateBindingMismatches(wiring, { ...accepted, artifactSha256: 'artifact-2' })).toEqual(['wiring_artifact_differs']);
    expect(candidateBindingMismatches({ ...wiring, artifact: undefined }, accepted)).toContain('wiring_artifact_differs');
  });

  test('the binding is checked in runPhase before rehearsal, preflight or any credential read', () => {
    const source = readFileSync(join(import.meta.dir, 'run.mjs'), 'utf8');
    const at = (needle: string) => source.indexOf(needle);
    expect(at('candidateBindingMismatches(candidateManifest')).toBeGreaterThan(-1);
    expect(at('candidateBindingMismatches(candidateManifest')).toBeLessThan(at('await rehearseSelection(ctx'));
    expect(at('candidateBindingMismatches(candidateManifest')).toBeLessThan(at('readAccessOnly(authPath'));
  });
});

describe('in-container fixture helpers', () => {
  const request = (tools: string[], user: string, after: any[] = []) => ({
    tools: tools.map((name) => ({ function: { name } })),
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: user }, ...after],
  });

  test('the scripted mock emits native calls for each host', () => {
    const script = scriptDirective([{ op: 'dispatch', agent: 'forager-worker', prompt: 'go', script: [] }]);
    expect(mockDecision('v1', request(['task'], script)).call.tool).toBe('task');
    const v2 = mockDecision('v2', request(['subagent'], script)).call;
    expect(v2.tool).toBe('subagent');
    expect(v2.args.background).toBe(false);
    const read = scriptDirective([{ op: 'hive', tool: 'hive_repositories_status', args: {} }]);
    expect(mockDecision('v2', request(['execute'], read)).call).toEqual({ tool: 'execute', args: { code: 'return await tools.hive_repositories_status({})' } });
  });

  test('the mock advances one step per assistant turn and resolves scoped matches', () => {
    const sha = 'b'.repeat(40);
    const script = scriptDirective([{ op: 'shell', command: 'git rev-parse HEAD' }, { op: 'text', text: 'sourceCommit {{matchIn:shell:\\b([0-9a-f]{40})\\b}}' }]);
    const after = [
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'bash' } }] },
      { role: 'tool', tool_call_id: 'c1', content: sha },
    ];
    expect(mockDecision('v1', request(['bash'], script, after))).toEqual({ text: `sourceCommit ${sha}` });
    expect(mockDecision('v1', { messages: [{ role: 'user', content: script }] })).toEqual({ text: 'Fixture title' });
    // A `json` text step is one JSON document written as data.
    expect(mockDecision('v1', request(['bash'], scriptDirective([{ op: 'text', json: { reviews: [{ n: 1 }] } }])))).toEqual({ text: '{"reviews":[{"n":1}]}' });
  });

  test('exported arguments are allowlisted and bounded; tool outputs never appear', () => {
    expect(allowlistArgs('bash', { command: 'x'.repeat(5000), description: 'd' })).toEqual({ command: 'x'.repeat(1000) });
    expect(allowlistArgs('read', { filePath: '/a', offset: 3 })).toEqual({ path: '/a' });
    expect(allowlistArgs('webfetch', { url: 'https://example.invalid' })).toEqual({});
    expect(allowlistArgs('question', { questions: [{ question: 'Merge now?', options: [] }] })).toEqual({ question: 'Merge now?' });
    expect(allowlistArgs('hive_task_update', { task: 't', report: 'r'.repeat(3000), status: 'done' })).toEqual({ task: 't', report: 'r'.repeat(1000), status: 'done' });
  });

  test('a bound that cuts exported data says so, field by field, and lists only fields the allowlist carries', () => {
    expect(clipToolArgs('bash', { command: 'x'.repeat(1000) })).toEqual({ args: { command: 'x'.repeat(1000) }, truncated: [] });
    expect(clipToolArgs('bash', { command: 'x'.repeat(1001) }).truncated).toEqual(['command']);
    expect(clipToolArgs('hive_task_update', { task: 't', report: 'r'.repeat(1001), handoff: 'h', note: 'n'.repeat(301) }).truncated).toEqual(['report', 'note']);
    expect(clipToolArgs('task', { subagent_type: 'code-reviewer', prompt: 'p'.repeat(4001) }).truncated).toEqual(['prompt']);
    // A tool the allowlist does not carry exports nothing and claims nothing.
    expect(clipToolArgs('webfetch', { url: `https://example.invalid/${'u'.repeat(5000)}` })).toEqual({ args: {}, truncated: [] });
    expect(clipText('a'.repeat(FINAL_TEXT_CAP), FINAL_TEXT_CAP)).toMatchObject({ truncated: false, chars: FINAL_TEXT_CAP });
    const cut = clipText('a'.repeat(FINAL_TEXT_CAP + 1), FINAL_TEXT_CAP);
    expect(cut).toMatchObject({ truncated: true, chars: FINAL_TEXT_CAP + 1 });
    expect(cut.text).toHaveLength(FINAL_TEXT_CAP);
    expect(ARTIFACT_CAP).toBeGreaterThan(FINAL_TEXT_CAP);
  });

  test('the record states what it cannot show: sessions are not chronologically ordered and the cut-off data is named', () => {
    const empty = { ...NO_LIMITS_HIT };
    expect(evidenceLimits(empty)).toEqual({ seqScope: 'within_session_only', crossSessionOrder: 'unavailable', toolOutputs: 'not_exported', ...empty });
    const cut = evidenceLimits({ ...empty, finalTextTruncated: ['s2'], toolArgsTruncated: [{ session: 's1', seq: 3, fields: ['prompt'] }], historyIncomplete: ['s3'], requestsTruncated: true });
    expect(cut).toMatchObject({ finalTextTruncated: ['s2'], toolArgsTruncated: [{ session: 's1', seq: 3, fields: ['prompt'] }], historyIncomplete: ['s3'], requestsTruncated: true });
    // The case summary keeps the limits beside the outcome, so a manifest reader sees a clipped record as clipped.
    expect(caseSummary({ host: 'v1', group: 'g', outcome: 'collected', record: { limits: cut } }).evidenceLimits).toEqual(cut);
    expect(caseSummary({ host: 'v1', group: 'g', outcome: 'timeout' }).evidenceLimits).toBeNull();
  });

  test('newly exported limit fields fall under the same contamination scan as the rest of the record', () => {
    const scan = secretScanner({ access: FAKE_ACCESS, expires: Date.now() + 3_600_000, accountId: FAKE_ACCOUNT });
    const record = liveRecord();
    expect(scan(record)).toBe(false);
    expect(scan({ ...record, limits: { ...record.limits, artifactsTruncated: [FAKE_ACCESS] } })).toBe(true);
    expect(scan({ ...record, limits: { ...record.limits, toolArgsTruncated: [{ session: FAKE_ACCOUNT, seq: 0, fields: ['x'] }] } })).toBe(true);
  });

  test('tool outcomes come from each call state: verified children, structured Hive failures and exit codes', () => {
    const parent = { id: 'p' };
    const tree = [{ id: 'p' }, { id: 'c', parentId: 'p', agent: 'code-reviewer', assistantMessages: 1, errors: 0 }, { id: 'ses_child', parentId: 'p', agent: 'code-reviewer', assistantMessages: 1, errors: 0 }];
    const dispatch = (metadata: any, agent = 'code-reviewer') => ({ name: 'task', status: 'completed', input: { subagent_type: agent }, metadata, output: '' });
    expect(toolOutcome(dispatch({ sessionId: 'c' }), parent, tree)).toEqual({ result: 'success', childSessionId: 'c', childAgent: 'code-reviewer' });
    expect(toolOutcome(dispatch({ sessionId: 'c' }, 'forager-worker'), parent, tree).result).toBe('unknown');
    expect(toolOutcome(dispatch({ sessionId: 'missing' }), parent, tree).result).toBe('unknown');
    expect(toolOutcome({ name: 'subagent', status: 'completed', input: { agent: 'code-reviewer' }, metadata: { sessionID: 'c', status: 'failed' }, output: '' }, parent, tree).result).toBe('failure');
    expect(toolOutcome({ name: 'subagent', status: 'completed', input: { agent: 'code-reviewer' }, metadata: null, output: '<subagent sessionID="ses_child" state="completed">ok</subagent>' }, parent, tree).result).toBe('success');
    expect(toolOutcome({ name: 'hive_worktree_merge', status: 'completed', output: JSON.stringify({ success: false, error: { code: 'TARGET_RECONCILIATION_REQUIRED' } }) }, parent, tree))
      .toEqual({ result: 'failure', code: 'TARGET_RECONCILIATION_REQUIRED' });
    expect(toolOutcome({ name: 'hive_status', status: 'completed', output: 'not json at all' }, parent, tree).result).toBe('unknown');
    expect(toolOutcome({ name: 'bash', status: 'completed', metadata: { exit: 1 }, output: '' }, parent, tree)).toEqual({ result: 'failure', exitCode: 1 });
    expect(toolOutcome({ name: 'bash', status: 'error', errorName: 'tool_error' }, parent, tree)).toEqual({ result: 'failure', code: 'tool_error' });
    expect(toolOutcome({ name: 'skill', status: 'completed', output: 'Base directory: /work/user-skills/adversarial-review' }, parent, tree)).toEqual({ result: 'success', source: 'user' });
  });

  test('Code Mode submissions are recorded as execute calls; mentioning a Hive tool in code is not evidence it ran', () => {
    const call = { name: 'execute', status: 'completed', input: { code: 'await tools.hive_worktree_merge({"task":"05"})' }, output: '{"success":false}' };
    expect(toolOutcome(call, { id: 'p' }, [])).toEqual({ result: 'success' });
    expect(allowlistArgs('execute', call.input)).toEqual({ code: call.input.code });
    const record = liveRecord({ toolCalls: [{ seq: 0, session: 's1', tool: 'execute', status: 'completed', args: allowlistArgs('execute', call.input), outcome: toolOutcome(call, { id: 'p' }, []) }] });
    expect(verdict(group('milestone-closure'), 'companion-merged', record)).toBe('fail');
  });

  test('exported names are fixed-vocabulary only', () => {
    expect(safeName('ProviderAuthError')).toBe('ProviderAuthError');
    expect(safeName('Bearer abc def')).toBe('other');
    expect(safeName(undefined)).toBeNull();
  });

  test('Code Mode catalog blocks keep field documentation for the exposure account', () => {
    const system = '## Available tools\n\n- hive_x (1 tool)\n  - tools.hive_x({\n  /** field doc */\n  a: string,\n}) // desc\n- opencode (5 tools)\n';
    expect(codeModeBlocks(system, ['hive_x']).hive_x).toContain('field doc');
  });

  test('templates render facts, keep unresolved tokens, allow quantifier braces and fill long documents', () => {
    expect(render('{{a}} {{missing}} {{match:x{40}}}', { a: 'A' })).toBe('A {{missing}} {{match:x{40}}}');
    expect(render({ nested: ['{{a}}'] }, { a: { k: 1 } })).toEqual({ nested: ['{"k":1}'] });
    expect(render('{{fill:3}}', {}).split('\n').length).toBe(3);
  });

  test('Hive results that report failure in any documented shape are rejected', () => {
    expect(hiveResultFailed({ approval: { success: true }, sync: { success: false } })).toBe(true);
    expect(hiveResultFailed({ success: false })).toBe(true);
    expect(hiveResultFailed(null)).toBe(true);
    expect(hiveResultFailed({ name: 'f', status: 'planning' })).toBe(false);
  });

  test('host-neutral steps map to each host native argument names', () => {
    expect(nativeToolCall('v1', { op: 'write', path: '/p', content: 'c' }, ['write'])).toEqual({ tool: 'write', args: { filePath: '/p', content: 'c' } });
    expect(nativeToolCall('v2', { op: 'shell', command: 'ls' }, ['shell'])).toEqual({ tool: 'shell', args: { command: 'ls' } });
  });

  test('the guard module only runs as a command, so importing it has no side effects', () => {
    expect(existsSync(join(import.meta.dir, 'guard.mjs'))).toBe(true);
    expect(GUARD_EXIT_CODE).toBe(86);
  });
});

describe('in-container export scan', () => {
  // The scan is the first of two: the host scans again with the in-memory credential. Both must hold on their own, so
  // these cases use an opaque access token and account ID that no token-shape pattern recognizes.
  const injectedSha = createHash('sha256').update(FAKE_ACCESS).digest('hex');
  const v1Entry = { type: 'oauth', access: FAKE_ACCESS, refresh: REFRESH_SENTINEL, expires: 1, accountId: FAKE_ACCOUNT };
  const v2Entry = { integrationID: 'openai', value: { type: 'oauth', access: FAKE_ACCESS, refresh: REFRESH_SENTINEL, expires: 1, metadata: { accountID: FAKE_ACCOUNT } } };
  const reply = (body: any, status = 200) => async () => ({ status, ok: status >= 200 && status < 300, body });
  const v1Source = (auth: string | null) => {
    const path = join(scratch(), 'auth.json');
    if (auth !== null) writeFileSync(path, auth);
    return { injectedAccessSha: injectedSha, authFile: path, get: async () => { throw new Error('v1 reads no API'); } };
  };
  const v2Source = (get: (path: string) => Promise<any>) => ({ injectedAccessSha: injectedSha, authFile: '/nonexistent/auth.json', get });
  const leaking = liveRecord({ finalText: `report mentions ${FAKE_ACCESS} and ${FAKE_ACCOUNT}` });
  const clean = liveRecord({ finalText: GOOD_HANDOFF });

  // Every way the container's own credential lookup can fail while a credential is present.
  const unavailable: [string, 'v1' | 'v2', any][] = [
    ['v1 auth file missing', 'v1', v1Source(null)],
    ['v1 auth file malformed', 'v1', v1Source('{not json')],
    ['v1 auth file without an openai entry', 'v1', v1Source(JSON.stringify({ anthropic: v1Entry }))],
    ['v1 openai entry without the injected access token', 'v1', v1Source(JSON.stringify({ openai: { ...v1Entry, access: 'another-token-0123456789' } }))],
    ['v1 openai entry with a non-string access token', 'v1', v1Source(JSON.stringify({ openai: { ...v1Entry, access: { value: FAKE_ACCESS } } }))],
    ['v2 request throws', 'v2', v2Source(async () => { throw new Error(`connect refused ${FAKE_ACCESS}`); })],
    ['v2 HTTP error', 'v2', v2Source(reply({ data: [v2Entry] }, 500))],
    ['v2 malformed body', 'v2', v2Source(reply(null))],
    ['v2 body that is not a list', 'v2', v2Source(reply({ data: { openai: v2Entry } }))],
    ['v2 empty list', 'v2', v2Source(reply({ data: [] }))],
    ['v2 entries without the injected access token', 'v2', v2Source(reply({ data: [{ ...v2Entry, value: { ...v2Entry.value, access: 'another-token-0123456789' } }, { integrationID: 'other' }] }))],
    ['v2 entry without a value', 'v2', v2Source(reply({ data: [{ integrationID: 'openai' }] }))],
  ];

  test.each(unavailable)('a credentialed container whose lookup fails (%s) exports a fixed code, never a record', async (_name, host, source) => {
    for (const record of [leaking, clean]) {
      const decision = await exportDecision(record, host, 'substantive-handoff', source);
      expect(decision).toEqual({ ok: false, failure: 'secret_scan_unavailable', host, scenario: 'substantive-handoff' });
      expect(JSON.stringify(decision)).not.toContain(FAKE_ACCESS);
    }
    expect(await containerSecrets(host, source)).toBeNull();
  });

  const healthy: ['v1' | 'v2', any][] = [
    ['v1', v1Source(JSON.stringify({ openai: v1Entry }))],
    ['v2', v2Source(reply({ data: [v2Entry] }))],
    ['v2', v2Source(reply([v2Entry]))],
  ];

  test.each(healthy)('a healthy exact lookup on %s finds the opaque values and lets a clean record leave', async (host, source) => {
    expect(await containerSecrets(host, source)).toEqual([FAKE_ACCESS, FAKE_ACCOUNT]);
    expect(await exportDecision(clean, host, 'substantive-handoff', source)).toEqual({ ok: true, record: clean });
    for (const text of [FAKE_ACCESS, FAKE_ACCOUNT]) {
      expect(await exportDecision(liveRecord({ finalText: `x ${text} y` }), host, 'substantive-handoff', source))
        .toEqual({ ok: false, failure: 'export_contaminated', host, scenario: 'substantive-handoff' });
    }
  });

  test('a credential-free container needs no lookup: a clean record leaves and a token-shaped string still stops it', async () => {
    const credentialFree = { injectedAccessSha: null, authFile: '/nonexistent/auth.json', get: async () => { throw new Error('no host read expected'); } };
    for (const host of ['v1', 'v2']) {
      expect(await containerSecrets(host, credentialFree)).toEqual([]);
      expect(await exportDecision(clean, host, 'substantive-handoff', credentialFree)).toEqual({ ok: true, record: clean });
      const shaped = liveRecord({ finalText: 'sk-' + 'a'.repeat(24) });
      expect(await exportDecision(shaped, host, 'substantive-handoff', credentialFree)).toMatchObject({ ok: false, failure: 'export_contaminated' });
    }
  });
});

// -----------------------------------------------------------------------------------------------------------------
// Supervised exercises (exercise.mjs, exercise-driver.ts, plan-reader.ts). Same synthetic rules: no Docker engine,
// network or real credential; the guard, auth file and native API are replaced by in-memory fakes.

const api = (body: any, status = 200): any => ({ outcome: 'response', status, body, bytes: 0 });
const routeGet = (table: Record<string, any>) => async (request: any) => table[request.path] ?? api(null, 404);

describe('supervised exercise credential continuity', () => {
  const now = 1_800_000_000_000;
  const entry = { type: 'oauth', access: FAKE_ACCESS, refresh: FAKE_REFRESH, expires: now + 3 * 3_600_000, accountId: FAKE_ACCOUNT };

  test('one bounded descriptor read gives the fingerprint and the credential from the same bytes', () => {
    const path = authFile(entry);
    const snapshot = snapshotAuthFile(path);
    const legacy = fingerprintAuthFile(path);
    expect(snapshot.fingerprint).toMatchObject({ exists: true, size: legacy.size, mtimeNs: legacy.mtimeNs, ino: legacy.ino, digest: legacy.digest });
    expect(credentialFromSnapshot(snapshot, { now, requiredMs: 0 })).toEqual(readAccessOnly(path, { now, requiredMs: 0 }));
    expect(snapshotAuthFile(join(scratch(), 'absent.json'))).toEqual({ fingerprint: { exists: false }, bytes: null });
    expect(() => credentialFromSnapshot({ fingerprint: { exists: false }, bytes: null }, { now, requiredMs: 0 })).toThrow('auth_missing');
    expect(() => snapshotAuthFile(path, { maxBytes: 8 })).toThrow('auth_oversize');
  });

  test('a file that changes during the read, or whose path is replaced, is refused rather than fingerprinted', () => {
    const path = authFile(entry);
    const real = { openSync: require('node:fs').openSync, fstatSync: require('node:fs').fstatSync, readSync: require('node:fs').readSync, closeSync: require('node:fs').closeSync, statSync: require('node:fs').statSync };
    let fstats = 0;
    const changing = { ...real, fstatSync: (fd: number, o: any) => { const s = real.fstatSync(fd, o); return ++fstats === 2 ? { ...s, isFile: () => true, mtimeNs: s.mtimeNs + 1n } : s; } };
    expect(() => snapshotAuthFile(path, { fs: changing })).toThrow('auth_changed_during_read');
    const replaced = { ...real, statSync: (p: string, o: any) => ({ ...real.statSync(p, o), ino: 1n }) };
    expect(() => snapshotAuthFile(path, { fs: replaced })).toThrow('auth_changed_during_read');
  });

  test('wire fingerprints keep BigInt fields exact and the guard refuses lossy or partial values', () => {
    const big = { exists: true, size: 10n, mtimeNs: 1_792_201_844_045_123_456n, ino: 2n ** 60n + 7n, digest: 'b'.repeat(64) };
    const wire = fingerprintWire(big);
    expect(wire).toEqual({ exists: true, size: '10', mtimeNs: '1792201844045123456', ino: '1152921504606846983', digest: 'b'.repeat(64) });
    expect(parseWireFingerprint(wire)).toEqual(wire);
    expect(parseWireFingerprint({ ...wire, mtimeNs: 1792201844045123456 })).toBeNull();
    expect(parseWireFingerprint({ ...wire, extra: '1' })).toBeNull();
    expect(parseWireFingerprint({ exists: true, size: '1' })).toBeNull();
    expect(parseWireFingerprint({ exists: false })).toEqual({ exists: false });
  });

  test('after rotation the original fingerprint no longer matches, so the replacement token is never adopted', () => {
    const path = authFile(entry);
    const guard = new GuardState(1000, { mono: () => 0, wall: () => now });
    expect(guard.bind({ runId: 'r', host: 'v1', fingerprint: fingerprintWire(snapshotAuthFile(path).fingerprint) }).ok).toBe(true);
    expect(guard.compare({ fingerprint: fingerprintWire(snapshotAuthFile(path).fingerprint) })).toMatchObject({ ok: true, matches: true });
    writeFileSync(path, JSON.stringify({ openai: { ...entry, access: 'replacement-access-token-9876543210fedcba' } }));
    expect(guard.compare({ fingerprint: fingerprintWire(snapshotAuthFile(path).fingerprint) })).toMatchObject({ ok: true, matches: false });
  });

  test('the evidence scanner finds the exact token, the account, token shapes and any 32-character fragment', () => {
    const scan = evidenceScanner({ access: FAKE_ACCESS, expires: now, accountId: FAKE_ACCOUNT });
    expect(scan(`x ${FAKE_ACCESS} y`)).toBe(true);
    expect(scan(`x ${FAKE_ACCOUNT}`)).toBe(true);
    expect(scan(`clipped ${FAKE_ACCESS.slice(0, 32)}`)).toBe(true);
    expect(scan(`chunk ${FAKE_ACCESS.slice(7, 39)}`)).toBe(true);
    expect(scan(`short ${FAKE_ACCESS.slice(0, 31)}`)).toBe(false);
    expect(scan('sk-' + 'a'.repeat(24))).toBe(true);
    expect(scan({ text: 'ordinary exercise text' })).toBe(false);
    const short = evidenceScanner({ access: 'short-token-123', expires: now });
    expect(short('value short-token-123 here')).toBe(true);
    expect(evidenceScanner(null)('sk-' + 'b'.repeat(24))).toBe(true);
  });

  test('a full 1800 s live run needs 2400 s of credential lifetime on v1 and 2700 s on v2', () => {
    expect(operationLifetimeMs('v1', 1_800_000)).toBe(2_400_000);
    expect(operationLifetimeMs('v2', 1_800_000)).toBe(2_700_000);
  });
});

describe('supervised exercise guard', () => {
  const clocks = () => {
    const c = { mono: 1_000, wall: 1_700_000_000_000 };
    return { c, guard: (ceiling = 100) => new GuardState(ceiling, { mono: () => c.mono, wall: () => c.wall }) };
  };
  const fp = { exists: true, size: '10', mtimeNs: '1700000000000000001', ino: '42', digest: 'a'.repeat(64) };

  test('arming only shortens the ceiling and a second arm is refused', () => {
    const { guard } = clocks();
    const g = guard(100);
    expect(g.arm(200)).toMatchObject({ ok: true, armed: true, remainingMs: 100_000 });
    expect(g.arm(10)).toMatchObject({ ok: false, failure: 'already_armed', remainingMs: 100_000 });
    expect(guard().arm(0)).toEqual({ ok: false, failure: 'request_invalid' });
    expect(guard().arm(1.5)).toEqual({ ok: false, failure: 'request_invalid' });
  });

  test('deadlines follow the monotonic clock: a wall-clock change neither extends nor shortens them, pauses count', () => {
    const { c, guard } = clocks();
    const g = guard(100);
    g.arm(60);
    c.wall += 3_600_000;
    expect(g.remainingMs()).toBe(60_000);
    c.wall -= 7_200_000;
    expect(g.remainingMs()).toBe(60_000);
    c.mono += 45_000;
    expect(g.remainingMs()).toBe(15_000);
    c.mono += 30_000;
    expect(g.remainingMs()).toBe(0);
  });

  test('bind happens once, before arming; compare returns only a Boolean; status never carries the fingerprint', () => {
    const { guard } = clocks();
    const g = guard();
    expect(g.compare({ fingerprint: fp })).toEqual({ ok: false, failure: 'not_bound' });
    expect(g.bind({ runId: 'run-1', host: 'v2', fingerprint: fp })).toMatchObject({ ok: true, bound: true, boundRunId: 'run-1', boundHost: 'v2' });
    expect(g.bind({ runId: 'run-2', host: 'v2', fingerprint: fp })).toMatchObject({ ok: false, failure: 'already_bound' });
    expect(g.compare({ fingerprint: fp })).toEqual({ ok: true, matches: true, remainingMs: 100_000, clockMs: 1_000, deadlineClockMs: 101_000 });
    expect(g.compare({ fingerprint: { ...fp, ino: '43' } })).toMatchObject({ ok: true, matches: false });
    expect(JSON.stringify(g.reply({ op: 'status' }))).not.toContain(fp.digest);
    expect(g.bind({ runId: 'bad id', host: 'v2', fingerprint: fp })).toMatchObject({ ok: false });
    const armedFirst = guard();
    armedFirst.arm(10);
    expect(armedFirst.bind({ runId: 'run-1', host: 'v1', fingerprint: fp })).toMatchObject({ ok: false, failure: 'bind_after_arm' });
  });

  test('the fixed-run guard replies keep their fields', () => {
    const { guard } = clocks();
    const g = guard(100);
    expect(g.reply({ op: 'status' })).toMatchObject({ ok: true, armed: false, startedAt: expect.any(Number), ceilingAt: expect.any(Number), deadlineAt: expect.any(Number), armedAt: null, remainingMs: 100_000 });
    expect(g.reply({ op: 'arm', seconds: 30 })).toMatchObject({ ok: true, armed: true, armedAt: expect.any(Number) });
    expect(g.reply({ op: 'other' })).toEqual({ ok: false, failure: 'request_invalid' });
  });

  test('status, arm and compare report the guard clock and its deadline on that clock, never the wall clock', () => {
    const { c, guard } = clocks();
    const g = guard(100);
    expect(g.reply({ op: 'status' })).toMatchObject({ clockMs: 1_000, deadlineClockMs: 101_000, remainingMs: 100_000 });
    expect(g.bind({ runId: 'r', host: 'v1', fingerprint: fp })).toMatchObject({ ok: true, clockMs: 1_000, deadlineClockMs: 101_000 });
    c.mono += 5_000;
    c.wall -= 3_600_000;
    expect(g.reply({ op: 'arm', seconds: 30 })).toMatchObject({ clockMs: 6_000, deadlineClockMs: 36_000, remainingMs: 30_000 });
    c.mono += 1_000;
    expect(g.compare({ fingerprint: fp })).toEqual({ ok: true, matches: true, remainingMs: 29_000, clockMs: 7_000, deadlineClockMs: 36_000 });
  });
});

describe('supervised exercise resources and builds', () => {
  test('a create whose client did not complete stays unknown on an empty listing; it is never cleared as absent', async () => {
    // The client times out before the daemon has created anything; the daemon may still finish later.
    class NotYetCreated extends FakeDocker {
      async run(args: string[], options: any = {}) {
        if (args[0] === 'network' && args[1] === 'create') { this.calls.push({ args }); return { code: 1, stdout: '', stderr: '', timedOut: true }; }
        return super.run(args, options);
      }
    }
    const docker = new NotYetCreated();
    const ledger = join(scratch(), 'r.jsonl');
    const resources = new Resources(docker as any, ledger, 'run', ENGINE, { strictCreates: true });
    const lost = resources.create('network', (labels: string[]) => ['network', 'create', ...labels, 'n']);
    await expect(lost).rejects.toMatchObject({ code: 'create_unknown' });
    expect(resources.pendingCreates.size).toBe(1);
    expect(readFileSync(ledger, 'utf8')).toContain('"create_unknown"');
    expect(readFileSync(ledger, 'utf8')).not.toContain('"create_absent"');
    expect(outstandingFromLedger(readFileSync(ledger, 'utf8')).nonces.size).toBe(1);
    expect((await resources.removeAll()).some((r: any) => r.state === 'unknown')).toBe(true);
    expect(resources.settled).toBe(false);
  });

  test('a late-created resource found by its nonce is adopted and removed by exact ID', async () => {
    const docker = new FakeDocker({ loseCreate: true });
    const resources = new Resources(docker as any, join(scratch(), 'r.jsonl'), 'run', ENGINE, { strictCreates: true });
    await expect(resources.create('network', (labels: string[]) => ['network', 'create', ...labels, 'n'])).rejects.toMatchObject({ code: 'create_failed' });
    expect(resources.live.size).toBe(1);
    expect((await resources.removeAll()).every((r: any) => r.state === 'absent')).toBe(true);
  });

  test('an unsuccessful create stays unknown on an empty listing whatever the client printed; only its found resource settles it', async () => {
    // The client exits with a daemon-style refusal, a transport error, a signal or a timeout; in each case the daemon
    // may still create the network afterwards.
    const failures = [
      { code: 1, stdout: '', stderr: 'Error response from daemon: invalid reference format', timedOut: false },
      { code: 1, stdout: '', stderr: 'error during connect: EOF', timedOut: false },
      { code: -1, stdout: '', stderr: '', timedOut: false },
      { code: 1, stdout: 'not-an-id', stderr: '', timedOut: true },
    ];
    class LateCreation extends FakeDocker {
      held: string[][] = [];
      constructor(public failure: any) { super(); }
      async run(args: string[], options: any = {}) {
        if (args[0] === 'network' && args[1] === 'create') { this.calls.push({ args }); this.held.push(args); return this.failure; }
        return super.run(args, options);
      }
      async daemonFinishes() { for (const args of this.held.splice(0)) await FakeDocker.prototype.run.call(this, args, {}); }
    }
    for (const failure of failures) {
      const docker = new LateCreation(failure);
      const ledger = join(scratch(), 'r.jsonl');
      const resources = new Resources(docker as any, ledger, 'run', ENGINE, { strictCreates: true });
      await expect(resources.create('network', (labels: string[]) => ['network', 'create', ...labels, 'n'])).rejects.toMatchObject({ code: 'create_unknown' });
      expect(resources.pendingCreates.size).toBe(1);
      expect(readFileSync(ledger, 'utf8')).toContain('"create_unknown"');
      expect(readFileSync(ledger, 'utf8')).not.toContain('"create_absent"');
      // The listing stays empty: cleanup stays unknown, however often it is retried.
      for (let i = 0; i < 2; i++) {
        expect((await resources.removeAll()).some((r: any) => r.state === 'unknown')).toBe(true);
        expect(resources.settled).toBe(false);
      }
      expect(outstandingFromLedger(readFileSync(ledger, 'utf8')).nonces.size).toBe(1);
      // The late creation is found by its nonce and removed by exact ID.
      await docker.daemonFinishes();
      expect((await resources.removeAll()).every((r: any) => r.state === 'absent')).toBe(true);
      expect(resources.settled).toBe(true);
      expect(outstandingFromLedger(readFileSync(ledger, 'utf8'))).toEqual({ ids: new Map(), nonces: new Map() });
    }
    // The fixed-run (non-strict) behavior is unchanged: an empty listing after a failed client still settles absent.
    for (const failure of failures.slice(0, 2)) {
      const legacy = new Resources(new LateCreation(failure) as any, join(scratch(), 'l.jsonl'), 'run', ENGINE);
      await expect(legacy.create('network', (labels: string[]) => ['network', 'create', ...labels, 'n'])).rejects.toMatchObject({ code: 'create_failed' });
      expect(legacy.settled).toBe(true);
    }
  });

  test('a supervised run whose lost create never appears stops as cleanup_unknown and keeps the nonce', async () => {
    const run = exerciseRun({ ledger: JSON.stringify({ event: 'create_requested', kind: 'network', nonce: 'never-found' }) + '\n' });
    for (let i = 0; i < 2; i++) {
      const stopped = await stopCommand({ run: run.runDir }, {}, { docker: new ExerciseDocker() });
      expect(stopped).toMatchObject({ exit: EXIT.failed, status: { status: 'cleanup_unknown', retained: [{ nonce: 'never-found', state: 'unknown' }] } });
    }
    expect(outstandingFromLedger(readFileSync(join(run.runDir, 'resources.jsonl'), 'utf8')).nonces.get('never-found')).toBe('network');
  });

  test('command budgets bound every Docker call', async () => {
    const timeouts: number[] = [];
    class Timing extends FakeDocker { async run(args: string[], options: any = {}) { timeouts.push(options.timeoutMs); return super.run(args, options); } }
    const bounded = new Resources(new Timing() as any, join(scratch(), 'r.jsonl'), 'run', ENGINE, { remainingMs: () => 5_000 });
    await bounded.create('container', (labels: string[]) => ['create', ...labels, '--network', 'none', 'img', '120']);
    expect(Math.max(...timeouts)).toBeLessThanOrEqual(5_000);
    const exhausted = new Resources(new FakeDocker() as any, join(scratch(), 'r.jsonl'), 'run', ENGINE, { remainingMs: () => 0 });
    await expect(exhausted.create('network', (labels: string[]) => ['network', 'create', ...labels, 'n'])).rejects.toMatchObject({ code: 'command_deadline_exceeded' });
  });

  test('the exercise core bundle must come from the same subject, match its hash and expose the public read functions', () => {
    const core = { file: '/x/hive-core-reader.js', sha256: 'c'.repeat(64), subjectCommit: 'a'.repeat(40) };
    const good = { exerciseCore: { coreSha256: core.sha256, exports: { getFeaturePath: 'function', getPlanPath: 'function', PlanService: 'function' } } };
    expect(exerciseCoreFailures({ core }, good, 'a'.repeat(40))).toEqual([]);
    expect(exerciseCoreFailures({}, good, 'a'.repeat(40))).toContain('core_bundle_missing');
    expect(exerciseCoreFailures({ core }, good, 'b'.repeat(40))).toContain('core_bundle_subject_differs');
    expect(exerciseCoreFailures({ core }, { exerciseCore: { ...good.exerciseCore, coreSha256: 'd'.repeat(64) } }, 'a'.repeat(40))).toContain('core_bundle_hash_mismatch');
    expect(exerciseCoreFailures({ core }, { exerciseCore: { ...good.exerciseCore, exports: { getFeaturePath: 'function', getPlanPath: 'function' } } }, 'a'.repeat(40))).toContain('core_export_missing:PlanService');
    expect(exerciseCoreFailures({ core }, {}, 'a'.repeat(40))).toContain('core_report_missing');
    // The fixed-run checks never ask for the sidecar.
    expect(artifactFailures({ hiveCoreResolvedInArchive: true, coreBuiltFirst: true, packEntries: ['dist/index.js'] })).toEqual([]);
  });

  test('the Dockerfile adds exercise-only targets beside unchanged fixed-run targets, and the context admits only the bundle', () => {
    const dockerfile = readFileSync(join(import.meta.dir, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('FROM scratch AS artifact\nCOPY --from=builder /out/oc-arkive.tgz /out/build-report.json /\n');
    expect(dockerfile).toContain('FROM scratch AS exercise-artifact');
    expect(dockerfile).toContain('COPY --from=builder /src/packages/hive-core/dist/index.js /hive-core-reader.js');
    expect(dockerfile).toContain('FROM runtime AS exercise-runtime');
    expect(dockerfile).toMatch(/sha256sum -c -[\s\S]*exercise-driver\.ts core-report/);
    expect(readFileSync(join(import.meta.dir, '.dockerignore'), 'utf8').split('\n')).toContain('!hive-core-reader.js');
  });
});

const EXERCISE_REQUEST = {
  schema: 'ic-exercise-request/v1', question: 'Does the primary ask before planning?', observables: ['native question'], stopConditions: ['plan approved'],
  model: { ref: 'openai/gpt-test', variant: null }, agentMode: 'dedicated', initialPrimary: 'architect-planner',
  primaryTransitions: [{ from: 'architect-planner', to: 'swarm-orchestrator' }], repository: 'repo', prompt: 'prompt.md', artifacts: ['README.md', '.hive/features/'],
};

/** A request directory `prepare` can snapshot: the request, its prompt and a small repository. */
function inputTree() {
  const base = scratch();
  mkdirSync(join(base, 'repo', 'src'), { recursive: true });
  writeFileSync(join(base, 'repo', 'README.md'), '# r\n');
  writeFileSync(join(base, 'repo', 'src', 'a.txt'), 'a\n');
  writeFileSync(join(base, 'prompt.md'), 'Plan it.\n');
  writeFileSync(join(base, 'request.json'), JSON.stringify(EXERCISE_REQUEST));
  return base;
}

describe('supervised exercise inputs and authority', () => {
  const code = (fn: () => unknown) => { try { fn(); return 'accepted'; } catch (e) { return (e as HarnessError).code; } };

  test('the CLI accepts only finite commands with a full candidate commit and a 61..1800 s budget', () => {
    const prepare = ['prepare', '--candidate-ref', 'a'.repeat(40), '--host', 'v1', '--input', '/r/request.json', '--run-id', 'r1', '--output-root', '/out'];
    expect(parseExerciseCli(prepare).command).toBe('prepare');
    expect(code(() => parseExerciseCli([...prepare.slice(0, 2), 'HEAD', ...prepare.slice(3)]))).toBe('candidate_ref_not_full_commit');
    expect(code(() => parseExerciseCli([...prepare, '--extra', 'x']))).toBe('arguments_invalid');
    const start = (budget: string) => code(() => parseExerciseCli(['start', '--run', '/out/r1', '--authorization', '/a.json', '--budget-seconds', budget]));
    expect(start('61')).toBe('accepted');
    expect(start(String(LIVE_MAX_SECONDS))).toBe('accepted');
    expect(start('60')).toBe('budget_invalid');
    expect(start('1801')).toBe('budget_invalid');
    expect(code(() => parseExerciseCli(['resume', '--run', '/x']))).toBe('command_unknown');
    expect(code(() => parseExerciseCli(['turn', '--run', '/x']))).toBe('argument_missing');
    expect(parseExerciseCli(['--help', 'turn'])).toEqual({ command: 'help', topic: 'turn' });
    expect(code(() => parseExerciseCli(['--help', 'resume']))).toBe('help_topic_unknown');
  });

  test('help needs no Docker, credential or run directory and documents every operation action', async () => {
    let out = '';
    const stdout = { write: (s: string) => { out += s; return true; } };
    expect(await exerciseMain(['--help'], { env: {}, stdout })).toBe(EXIT.ok);
    expect(out).toContain('EXERCISES.md');
    out = '';
    expect(await exerciseMain(['--help', 'turn'], { env: {}, stdout })).toBe(EXIT.ok);
    for (const action of ACTIONS) expect(out).toContain(action);
    expect(out).toContain('"once" | "reject"');
    expect(out).not.toContain('always');
  });

  test('requests accept only model, variant, agent-mode, transition and skill choices; provider, plugin and env passthrough is refused', () => {
    expect(validateRequest(EXERCISE_REQUEST).model).toEqual({ ref: 'openai/gpt-test', variant: null });
    for (const extra of [{ plugins: ['x'] }, { mcp: {} }, { env: { OPENAI_API_KEY: 'x' } }, { providerUrl: 'http://x' }, { permission: { '*': 'allow' } }]) {
      expect(code(() => validateRequest({ ...EXERCISE_REQUEST, ...extra }))).toBe('request_invalid');
    }
    expect(code(() => validateRequest({ ...EXERCISE_REQUEST, model: { ref: 'anthropic/claude', variant: null } }))).toBe('request_invalid');
    expect(code(() => validateRequest({ ...EXERCISE_REQUEST, agentModels: { 'architect-planner': { model: 'openai/x', variant: null } } }))).toBe('request_invalid');
    expect(validateRequest({ ...EXERCISE_REQUEST, agentModels: { 'code-reviewer': { model: 'openai/x', variant: 'high' } } }).agentModels).toEqual({ 'code-reviewer': { model: 'openai/x', variant: 'high' } });
    expect(code(() => validateRequest({ ...EXERCISE_REQUEST, dependencies: [{ command: 'npm-install', directory: '.' }] }))).toBe('request_invalid');
    for (const path of ['../x', '.git/config', 'node_modules/a', '/etc/passwd', 'a//b', '.hive/runtime/opencode-v2/sessions.json', '.hive/sessions.json']) {
      expect(code(() => validateRequest({ ...EXERCISE_REQUEST, artifacts: [path] }))).toBe('request_invalid');
    }
    expect(projectPath('.hive/features/')).toBe('.hive/features/');
  });

  test('snapshots hash bytes and the ordered inventory, and refuse links, hardlinks, excluded trees, escapes and oversize input', () => {
    const base = inputTree();
    const snapshot = snapshotInputs(join(base, 'request.json'));
    expect(snapshot.files.map((f: any) => f.path)).toEqual(['README.md', 'src/a.txt']);
    expect(snapshot.inventorySha256).toBe(snapshotInputs(join(base, 'request.json')).inventorySha256);
    writeFileSync(join(base, 'repo', 'src', 'a.txt'), 'changed\n');
    expect(snapshotInputs(join(base, 'request.json')).inventorySha256).not.toBe(snapshot.inventorySha256);
    const refused = (mutate: (base: string) => void) => { const b = inputTree(); mutate(b); return code(() => snapshotInputs(join(b, 'request.json'))); };
    expect(refused((b) => spawnSync('ln', ['-s', '/etc/hostname', join(b, 'repo', 'link')]))).toBe('input_link_refused');
    expect(refused((b) => spawnSync('ln', [join(b, 'repo', 'README.md'), join(b, 'repo', 'hard')]))).toBe('input_not_regular_file');
    expect(refused((b) => { mkdirSync(join(b, 'repo', '.git')); writeFileSync(join(b, 'repo', '.git', 'HEAD'), 'x'); })).toBe('input_path_refused');
    expect(refused((b) => { mkdirSync(join(b, 'repo', 'node_modules')); })).toBe('input_path_refused');
    expect(refused((b) => writeFileSync(join(b, 'repo', 'auth.json'), '{}'))).toBe('input_path_refused');
    expect(refused((b) => writeFileSync(join(b, 'repo', 'big.txt'), 'x'.repeat(256 * 1024 + 1)))).toBe('input_oversize');
    expect(refused((b) => writeFileSync(join(b, 'repo', 'bin.dat'), Buffer.from([0xff, 0xfe, 0x00])))).toBe('input_not_utf8');
    expect(refused((b) => writeFileSync(join(b, 'request.json'), JSON.stringify({ ...EXERCISE_REQUEST, prompt: '../prompt.md' })))).toBe('input_path_escapes');
    expect(refused((b) => { for (let i = 0; i < 256; i++) writeFileSync(join(b, 'repo', `f${i}.txt`), 'x'); })).toBe('input_file_count_exceeded');
  });

  test('a snapshot admits no project-local file that hive-core applies over the authorized model selection', () => {
    const home = scratch();
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    const authorized = { 'forager-worker': { model: 'openai/authorized', variant: 'high' } };
    writeFileSync(join(home, '.config', 'opencode', 'agent_hive.json'), JSON.stringify(exerciseHiveConfig({ agentMode: 'dedicated', agentModels: authorized })));
    const override = JSON.stringify({ agents: { 'forager-worker': { model: 'openai/different', variant: 'low' } } });
    // What the actual ConfigService resolves for the role when a project carries `layout`, with the exercise's own global configuration.
    const effective = (layout: string | null) => {
      const project = scratch();
      if (layout) {
        mkdirSync(join(project, ...layout.split('/').slice(0, -1)), { recursive: true });
        writeFileSync(join(project, ...layout.split('/')), override);
      }
      const realHome = process.env.HOME;
      process.env.HOME = home;
      try { return new ConfigService(project).get().agents?.['forager-worker']; } finally { process.env.HOME = realHome; }
    };
    expect(effective(null)).toMatchObject({ model: 'openai/authorized', variant: 'high' });
    const layouts = ['.hive/agent-hive.override.json', '.hive/agent-hive.json', '.opencode/agent_hive.json'];
    const honored = layouts.filter((layout) => effective(layout)?.model !== 'openai/authorized');
    // If hive-core starts reading another project-local file, this premise fails and the import boundary must follow.
    expect(honored).toEqual(['.hive/agent-hive.override.json']);
    expect(effective('.hive/agent-hive.override.json')).toMatchObject({ model: 'openai/different', variant: 'low' });
    for (const layout of honored) {
      const base = inputTree();
      mkdirSync(join(base, 'repo', ...layout.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(base, 'repo', ...layout.split('/')), override);
      expect(code(() => snapshotInputs(join(base, 'request.json')))).toBe('input_path_refused');
      expect(code(() => projectPath(layout))).toBe('path_invalid');
      expect(code(() => validateRequest({ ...EXERCISE_REQUEST, artifacts: [layout] }))).toBe('request_invalid');
    }
    // The explicit request selection stays the only way to choose role models; other project files under .hive import as before.
    expect(validateRequest({ ...EXERCISE_REQUEST, agentModels: { 'forager-worker': { model: 'openai/authorized', variant: 'high' } } }).agentModels).toEqual({ 'forager-worker': { model: 'openai/authorized', variant: 'high' } });
    const base = inputTree();
    mkdirSync(join(base, 'repo', '.hive', 'features'), { recursive: true });
    writeFileSync(join(base, 'repo', '.hive', 'features', 'note.md'), 'x\n');
    expect(snapshotInputs(join(base, 'request.json')).files.map((f: any) => f.path)).toContain('.hive/features/note.md');
  });

  test('authorization binds the prepared record, host, model and the exact budget', () => {
    const prepared = { host: 'v1', request: validateRequest(EXERCISE_REQUEST) };
    const auth = { schema: 'ic-exercise-authorization/v1', runId: 'r1', preparedSha256: 'p'.repeat(64), host: 'v1', model: { ref: 'openai/gpt-test', variant: null }, budgetSeconds: 900, allowedActions: ['prompt', 'reply'], stopConditions: ['done'], authorizedBy: 'supervisor' };
    const check = (value: any, budgetSeconds = 900) => code(() => validateAuthorization(value, { runId: 'r1', preparedSha256: 'p'.repeat(64), prepared, budgetSeconds }));
    expect(check(auth)).toBe('accepted');
    expect(check({ ...auth, runId: 'r2' })).toBe('authorization_mismatch');
    expect(check({ ...auth, preparedSha256: 'q'.repeat(64) })).toBe('authorization_mismatch');
    expect(check({ ...auth, host: 'v2' })).toBe('authorization_mismatch');
    expect(check({ ...auth, model: { ref: 'openai/other', variant: null } })).toBe('authorization_mismatch');
    expect(check(auth, 1800)).toBe('authorization_mismatch');
    expect(check({ ...auth, allowedActions: ['prompt', 'always'] })).toBe('authorization_invalid');
    expect(check({ ...auth, extendable: true })).toBe('authorization_invalid');
  });

  test('operations are bound to the run, the primary session and the authorized actions; permission offers once and reject only', () => {
    const base = { schema: 'ic-exercise-operation/v1', id: 'op-1', runId: 'r1', sessionId: 'ses_a' };
    const check = (value: any, allowedActions = ACTIONS) => code(() => validateOperation(value, { runId: 'r1', sessionId: 'ses_a', allowedActions }));
    expect(check({ ...base, action: 'prompt', text: 'go' })).toBe('accepted');
    expect(check({ ...base, action: 'prompt', text: 'go' }, ['reply'])).toBe('operation_not_authorized');
    expect(check({ ...base, sessionId: 'ses_b', action: 'prompt', text: 'go' })).toBe('operation_mismatch');
    expect(check({ ...base, action: 'permission', requestId: 'per_1', decision: 'always' })).toBe('operation_invalid');
    expect(check({ ...base, action: 'permission', requestId: 'per_1', decision: 'once' })).toBe('accepted');
    expect(check({ ...base, action: 'reply', requestId: 'que_1', answers: [] })).toBe('operation_invalid');
    expect(check({ ...base, action: 'prompt', text: 'go', path: '/api/session' })).toBe('operation_invalid');
    const approve = { ...base, action: 'approve-plan', project: PROJECT_ROOT, feature: 'f', revision: 'r1', contentHash: 'h1', permittedWork: 'edit README' };
    expect(check(approve)).toBe('accepted');
    expect(check({ ...approve, project: '/elsewhere' })).toBe('operation_mismatch');
    expect(check({ ...base, action: 'switch-primary', to: 'nobody' })).toBe('operation_invalid');
  });

  test('inspection requests stay inside the artifact allowlist and the fixed maxima', () => {
    const check = (value: any) => code(() => validateInspection({ schema: 'ic-exercise-inspection/v1', runId: 'r1', ...value }, { runId: 'r1', artifacts: ['README.md', '.hive/features/'] }));
    expect(check({ artifacts: ['README.md', '.hive/features/01_f/plan.md'], list: ['.hive/features/'], diff: true, conversation: { messagesPerPage: 50, pages: 2 } })).toBe('accepted');
    expect(check({ artifacts: ['src/secret.ts'] })).toBe('inspection_path_not_allowed');
    expect(check({ list: ['.hive/features'] })).toBe('inspection_path_invalid');
    expect(check({ conversation: { messagesPerPage: 101 } })).toBe('inspection_cap_exceeded');
    expect(check({ conversation: { pages: 11 } })).toBe('inspection_cap_exceeded');
    expect(check({ artifacts: Array.from({ length: 33 }, () => 'README.md') })).toBe('inspection_cap_exceeded');
    expect(check({ shell: 'npm test' })).toBe('inspection_invalid');
  });

  test('approval is a native user message naming one revision; the controller itself approves nothing', () => {
    const text = approvalMessage({ project: PROJECT_ROOT, feature: 'feat', revision: 'rev-7', contentHash: 'hash-7', permittedWork: 'edit README only' });
    expect(text).toContain("expectedRevision 'rev-7'");
    expect(text).toContain('only that revision');
    expect(text).toContain('do not approve');
    expect(text).toContain('edit README only');
    expect(readFileSync(join(import.meta.dir, 'exercise.mjs'), 'utf8')).not.toMatch(/PlanService|\.approve\(|APPROVED/);
  });

  test('observed selections compare model and variant per turn agent; a missing observation is unknown, never a match', () => {
    const turn = (agent: string | null, modelID: string, variant: string | null = null) => ({ role: 'assistant', agent, model: { providerID: 'openai', modelID, variant } });
    const selected = { ref: 'openai/gpt-test', variant: 'medium' };
    const agentModels = { 'code-reviewer': { model: 'openai/gpt-review', variant: 'high' } };
    const summary = (turns: any[], sel: any = selected, models: any = agentModels) => selectionSummary({ sessions: [{ id: 'ses_a', agent: null, turns }] }, { selected: sel, agentModels: models })[0];
    expect(summary([{ role: 'user' }, turn('architect-planner', 'gpt-test', 'medium')])).toMatchObject({ status: 'match', mismatch: false });
    expect(summary([turn('architect-planner', 'gpt-test', 'low')])).toMatchObject({ status: 'mismatch', mismatch: true });
    expect(summary([turn('architect-planner', 'gpt-other', 'medium')]).status).toBe('mismatch');
    expect(summary([turn('code-reviewer', 'gpt-review', 'high')]).status).toBe('match');
    expect(summary([turn('code-reviewer', 'gpt-review', 'medium')]).status).toBe('mismatch');
    expect(summary([turn('code-reviewer', 'gpt-review', null)]).status).toBe('unknown');
    expect(summary([turn(null, 'gpt-test', 'medium')]).status).toBe('unknown');
    expect(summary([{ role: 'user' }])).toMatchObject({ status: 'unknown', mismatch: false, observed: [] });
    expect(summary([])).toMatchObject({ status: 'unknown', observed: [] });
    expect(summary([turn('architect-planner', 'gpt-test', 'medium'), turn('architect-planner', 'gpt-test', 'low')]).status).toBe('mismatch');
    // v2 reports `default` for a turn that ran no variant: that is no variant when none was requested, and not the requested one when one was.
    expect(summary([turn('scout-researcher', 'gpt-test', 'default')], { ref: 'openai/gpt-test', variant: null }, {}).status).toBe('match');
    expect(summary([turn('architect-planner', 'gpt-test', 'default')]).status).toBe('mismatch');
    expect(summary([turn('code-reviewer', 'gpt-review', 'default')]).status).toBe('mismatch');
    expect(summary([turn('scout-researcher', 'gpt-test', 'high')], { ref: 'openai/gpt-test', variant: null }, {}).status).toBe('mismatch');
    expect(summary([turn('scout-researcher', 'gpt-test')], { ref: 'openai/gpt-test', variant: null }, {}).status).toBe('match');
  });

  test('every explicit model and variant choice is validated against the catalogs, not only the session primary', () => {
    const choices = [{ ref: 'openai/gpt-test', variant: 'medium' }, { ref: 'openai/gpt-review', variant: 'high' }];
    const labels = [{ model: 'model', variant: 'variant' }, { model: 'agent_model:code-reviewer', variant: 'agent_variant:code-reviewer' }];
    const params = { choices, labels, agents: ['architect-planner', 'code-reviewer'] };
    const row = (ref: string, over: any = {}) => ({ ref, listed: true, toolCall: true, variantListed: true, ...over });
    const reply = (choiceRows: any[], agents: any = { 'architect-planner': true, 'code-reviewer': true }) => ({ ok: true as const, agentsReadable: true, agents, choices: choiceRows });
    expect(catalogProblems(reply([row('openai/gpt-test'), row('openai/gpt-review')]), params)).toEqual([]);
    expect(catalogProblems(reply([row('openai/gpt-test'), row('openai/gpt-review', { listed: false })]), params)).toEqual(['agent_model:code-reviewer']);
    expect(catalogProblems(reply([row('openai/gpt-test'), row('openai/gpt-review', { variantListed: false })]), params)).toEqual(['agent_variant:code-reviewer']);
    expect(catalogProblems(reply([row('openai/gpt-test', { toolCall: false }), row('openai/gpt-review')]), params)).toEqual(['model']);
    expect(catalogProblems(reply([row('openai/gpt-test', { variantListed: null }), row('openai/gpt-review')]), params)).toEqual(['variant']);
    expect(catalogProblems(reply([row('openai/gpt-test')]), params)).toEqual(['catalog_mismatch']);
    expect(catalogProblems(reply([row('openai/gpt-test'), row('openai/other')]), params)).toEqual(['catalog_mismatch']);
    expect(catalogProblems(reply([row('openai/gpt-test'), row('openai/gpt-review')], { 'architect-planner': true, 'code-reviewer': false }), params)).toEqual(['agent:code-reviewer']);
    expect(parseDriverReply('catalog', { ok: true, agentsReadable: true, agents: { 'architect-planner': true }, choices: [row('openai/gpt-test')] })).not.toBeNull();
    expect(parseDriverReply('catalog', { ok: true, agentsReadable: true, agents: { 'no-such-role': true }, choices: [] })).toBeNull();
  });

  test('no new work in the final 60 s of the live deadline', () => {
    expect(admitsNewWork(NO_NEW_WORK_MS)).toBe(false);
    expect(admitsNewWork(NO_NEW_WORK_MS + 1)).toBe(true);
    expect(admitsNewWork(Number.NaN)).toBe(false);
  });

  test('qualification passes only when every named check was observed true', () => {
    const all = Object.fromEntries(QUALIFICATION_CHECKS.map((name) => [name, true]));
    expect(qualificationFailures(all)).toEqual([]);
    expect(qualificationFailures({ ...all, 'protocol.revisionBoundApproval': false })).toEqual(['protocol.revisionBoundApproval']);
    const { ['protocol.cleanupWithoutAuth']: _, ...missing } = all;
    expect(qualificationFailures(missing)).toEqual(['protocol.cleanupWithoutAuth']);
  });
});

describe('supervised exercise native adapters', () => {
  test('exercise configuration has no blanket permission and pins nothing beyond explicit choices', () => {
    for (const host of ['v1', 'v2']) {
      const cfg = exerciseHostConfig(host, { modelRef: 'openai/gpt-test', variant: null, provider: 'openai', mockPort: 1, serverPort: 2, observer: '/o' });
      expect(JSON.stringify(cfg)).not.toContain('"allow"');
      expect(cfg).not.toHaveProperty('permission');
      expect(cfg).not.toHaveProperty('permissions');
      const qual = exerciseHostConfig(host, { modelRef: 'mock/m', variant: null, provider: 'mock', mockPort: 1, serverPort: 2, observer: '/o', askExternalReads: true });
      expect(JSON.stringify(qual)).toContain('external_directory');
      expect(JSON.stringify(qual)).not.toContain('"allow"');
    }
    expect(exerciseHiveConfig({ agentMode: 'dedicated', agentModels: {} })).toEqual({ agentMode: 'dedicated', agents: {}, customAgents: {} });
    expect(exerciseHiveConfig({ agentMode: 'dedicated', agentModels: { 'code-reviewer': { model: 'openai/x', variant: 'high' } } }).agents).toEqual({ 'code-reviewer': { model: 'openai/x', variant: 'high' } });
  });

  test('prompts carry a supervisor-chosen message ID in the format both hosts accept', () => {
    const id = exerciseMessageId(1_792_201_844_045, 3);
    expect(id).toMatch(MESSAGE_ID);
    // The low 48 bits of (milliseconds * 0x1000 + counter), as both hosts' own generators encode them.
    expect(id.slice(4, 16)).toBe(((BigInt(1_792_201_844_045) * 0x1000n + 3n) & 0xffffffffffffn).toString(16).padStart(12, '0'));
    const v1 = exerciseRoutes('v1', '/work/proj').prompt({ sessionId: 'ses_a', messageId: id, agent: 'architect-planner', model: { ref: 'openai/gpt-test', variant: 'high' }, text: 'hi' });
    expect(v1).toEqual({ method: 'POST', path: '/session/ses_a/prompt_async', body: { messageID: id, agent: 'architect-planner', model: { providerID: 'openai', modelID: 'gpt-test' }, variant: 'high', parts: [{ type: 'text', text: 'hi' }] } });
    const v2 = exerciseRoutes('v2', '/work/proj');
    expect(v2.prompt({ sessionId: 'ses_a', messageId: id, text: 'hi' })).toEqual({ method: 'POST', path: '/api/session/ses_a/prompt', body: { id, text: 'hi' } });
    expect(v2.permissionReply('ses_c', 'per_1', 'once').body).toEqual({ decision: 'once' });
    expect(exerciseRoutes('v1', '/work/proj').permissionReply('ses_c', 'per_1', 'reject').body).toEqual({ reply: 'reject' });
    expect(v2.formReply('ses_a', 'frm_1', { q0: 'alpha' })).toEqual({ method: 'POST', path: '/api/session/ses_a/form/frm_1/reply', body: { answer: { q0: 'alpha' } } });
  });

  test('the session tree comes only from native parent links; a failed, malformed or unproven page is incomplete, never empty', async () => {
    const v1 = { '/session/ses_root': api({ id: 'ses_root' }), '/session/ses_root/children': api([{ id: 'ses_kid', parentID: 'ses_root' }]), '/session/ses_kid/children': api([]) };
    expect(await sessionTree('v1', 'ses_root', routeGet(v1))).toEqual({ sessions: [{ id: 'ses_root', parentId: null, agent: null }, { id: 'ses_kid', parentId: 'ses_root', agent: null }], complete: true, failure: null });
    expect((await sessionTree('v1', 'ses_root', routeGet({ ...v1, '/session/ses_root/children': api([{ id: 'ses_kid', parentID: 'ses_other' }]) }))).failure).toBe('parent_link_unproven');
    expect((await sessionTree('v1', 'ses_root', routeGet({ ...v1, '/session/ses_kid/children': api(null, 500) }))).failure).toBe('children_unreadable');
    expect((await sessionTree('v1', 'ses_root', routeGet({ ...v1, '/session/ses_root/children': api([{ id: 'not a session' }]) }))).failure).toBe('children_malformed');
    expect((await sessionTree('v1', 'ses_missing', routeGet(v1))).complete).toBe(false);
    const v2 = {
      '/api/session/ses_root': api({ data: { id: 'ses_root', agent: 'architect-planner' } }),
      '/api/session?parentID=ses_root&limit=100&order=asc': api({ data: [{ id: 'ses_a', parentID: 'ses_root', agent: 'scout-researcher' }], cursor: { next: 'c2' } }),
      '/api/session?parentID=ses_root&limit=100&cursor=c2': api({ data: [{ id: 'ses_b', parentID: 'ses_root' }], cursor: { next: null } }),
      '/api/session?parentID=ses_a&limit=100&order=asc': api({ data: [], cursor: {} }),
      '/api/session?parentID=ses_b&limit=100&order=asc': api({ data: [], cursor: { next: null } }),
    };
    const tree = await sessionTree('v2', 'ses_root', routeGet(v2));
    expect(tree.complete).toBe(true);
    expect(tree.sessions.map((s) => s.id)).toEqual(['ses_root', 'ses_a', 'ses_b']);
    expect((await sessionTree('v2', 'ses_root', routeGet({ ...v2, '/api/session?parentID=ses_b&limit=100&order=asc': api({ data: [], cursor: { next: 7 } }) }))).failure).toBe('children_cursor_malformed');
  });

  const msgV1 = (id: string, role: string, tools: any[] = [], text = '') => ({ info: { id, role, agent: 'architect-planner' }, parts: [...(text ? [{ type: 'text', text }] : []), ...tools.map((t) => ({ type: 'tool', callID: t.id, tool: t.name, state: { status: t.status ?? 'completed', input: t.input ?? {}, output: t.output ?? '' } }))] });

  test('histories are read within page caps; an oversize or malformed page ends the read incomplete', async () => {
    const pages = {
      '/session/s/message?limit=2': api([msgV1('m3', 'user'), msgV1('m4', 'assistant')]),
      '/session/s/message?limit=2&before=m3': api([msgV1('m1', 'user'), msgV1('m2', 'assistant')]),
      '/session/s/message?limit=2&before=m1': api([]),
    };
    const read = await readHistory('v1', 's', routeGet(pages), { limit: 2, pages: 10 });
    expect(read.complete).toBe(true);
    expect(read.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect((await readHistory('v1', 's', routeGet(pages), { limit: 2, pages: 1 }))).toMatchObject({ complete: false, failure: null });
    expect((await readHistory('v1', 's', routeGet({ '/session/s/message?limit=2': { outcome: 'oversize', status: 200, body: null, bytes: 9 } }), { limit: 2, pages: 2 })).failure).toBe('history_oversize');
    expect((await readHistory('v1', 's', routeGet({ '/session/s/message?limit=2': api([{ info: {} }]) }), { limit: 2, pages: 2 })).failure).toBe('history_malformed');
  });

  test('quiescence needs a complete tree, a stable second enumeration, complete histories, idle sessions, idle tools and no pending interaction', () => {
    const tree = { sessions: [{ id: 'a', parentId: null, agent: null }, { id: 'b', parentId: 'a', agent: null }], complete: true, failure: null };
    const idle = new Map([['a', { messages: [], complete: true, failure: null }], ['b', { messages: [], complete: true, failure: null }]]);
    expect(quiescence(tree, idle as any, new Set(), [], tree)).toEqual({ quiescent: true, reasons: [] });
    expect(quiescence(tree, idle as any, new Set(), []).reasons).toEqual(['tree_changed']);
    expect(quiescence(tree, idle as any, new Set(['b']), [], tree).reasons).toEqual(['session_busy:b']);
    expect(quiescence(tree, idle as any, null, null, tree).reasons).toEqual(['status_unknown', 'interactions_unknown']);
    expect(quiescence({ ...tree, complete: false, failure: 'session_cap' }, idle as any, new Set(), [], null).reasons).toContain('tree_incomplete:session_cap');
    const running = new Map(idle);
    running.set('b', { messages: [normalizeMessage('v1', msgV1('m', 'assistant', [{ id: 'c', name: 'bash', status: 'running' }]))!], complete: true, failure: null });
    expect(quiescence(tree, running as any, new Set(), [], tree).reasons).toEqual(['tool_running:b']);
    expect(quiescence(tree, idle as any, new Set(), [{ kind: 'permission', id: 'per_1', sessionId: 'b', toolCallId: 'c' }], tree).reasons).toEqual(['pending_permission:per_1']);
    // A session created after the enumeration is visible in status, in the interaction lists, or in a second enumeration.
    expect(quiescence(tree, idle as any, new Set(['ses_new']), [], tree).reasons).toEqual(['session_busy_outside_tree:ses_new']);
    expect(quiescence(tree, idle as any, new Set(), [{ kind: 'question', id: 'que_9', sessionId: 'ses_new', toolCallId: null, outsideTree: true }], tree).reasons).toEqual(['pending_outside_tree:que_9']);
    expect(quiescence(tree, idle as any, new Set(), [], { ...tree, sessions: [...tree.sessions, { id: 'ses_new', parentId: 'a', agent: null }] }).reasons).toEqual(['tree_changed']);
  });

  test('a child created while the observation is in progress makes it non-quiescent; without one the same reads are quiet', async () => {
    const run = async (childAppears: boolean, statusBody: any = {}) => {
      let enumerations = 0;
      const table: Record<string, () => any> = {
        '/session/ses_root': () => api({ id: 'ses_root' }),
        '/session/ses_root/children': () => { enumerations++; return api(childAppears && enumerations > 1 ? [{ id: 'ses_new', parentID: 'ses_root' }] : []); },
        '/session/ses_new/children': () => api([]),
        '/session/ses_root/message?limit=100': () => api([]),
        '/session/ses_new/message?limit=100': () => api([]),
        '/session/status': () => api(statusBody),
        '/question': () => api([]),
        '/permission': () => api([]),
      };
      return observeWith('v1', 'ses_root', async (request: any) => table[request.path]?.() ?? api(null, 404));
    };
    expect(await run(false)).toMatchObject({ quiescent: true, reasons: [] });
    const created = await run(true);
    expect(created.quiescent).toBe(false);
    expect(created.reasons).toContain('tree_changed');
    const busyChild = await run(true, { ses_new: { type: 'busy' } });
    expect(busyChild.reasons).toEqual(expect.arrayContaining(['tree_changed', 'session_busy_outside_tree:ses_new']));
  });

  test('pending interactions are listed with exact IDs and owners, never reduced to the first, and outside-tree entries are flagged', async () => {
    const tree = { sessions: [{ id: 'ses_a', parentId: null, agent: null }, { id: 'ses_b', parentId: 'ses_a', agent: null }], complete: true, failure: null };
    const v1 = {
      '/question': api([{ id: 'que_1', sessionID: 'ses_a', questions: [{ question: 'Which?', header: 'H', options: [{ label: 'alpha' }, { label: 'beta' }] }], tool: { callID: 'call_q' } }, { id: 'que_x', sessionID: 'ses_other', questions: [] }]),
      '/permission': api([{ id: 'per_1', sessionID: 'ses_b', permission: 'external_directory', patterns: ['/etc/*'], tool: { callID: 'call_r' } }, { id: 'per_2', sessionID: 'ses_b', permission: 'read', patterns: [] }]),
    };
    const pending = await pendingInteractions('v1', tree, routeGet(v1));
    // An interaction owned by a session outside the tree is listed and flagged, because it may belong to a child created after the enumeration.
    expect(pending!.map((p) => [p.kind, p.id, p.sessionId, p.toolCallId, p.outsideTree === true])).toEqual([['question', 'que_1', 'ses_a', 'call_q', false], ['question', 'que_x', 'ses_other', null, true], ['permission', 'per_1', 'ses_b', 'call_r', false], ['permission', 'per_2', 'ses_b', null, false]]);
    expect(pending![0].questions).toEqual([{ question: 'Which?', header: 'H', multiple: false, options: ['alpha', 'beta'], optionDescriptions: [undefined, undefined] }]);
    expect(await pendingInteractions('v1', tree, routeGet({ ...v1, '/permission': api({ not: 'a list' }) }))).toBeNull();
  });

  test('nativeCredentialMatches compares the native store with the expectation, never with a writable marker', async () => {
    const expected = { access: FAKE_ACCESS, accountId: FAKE_ACCOUNT, expires: 123 };
    const v1 = (entry: any) => ({ file: () => JSON.stringify({ openai: entry }), credentials: async () => api(null, 500) });
    const stored = { access: FAKE_ACCESS, refresh: REFRESH_SENTINEL, expires: 123, accountId: FAKE_ACCOUNT };
    expect(await nativeCredentialMatches('v1', expected, v1(stored))).toBe(true);
    expect(await nativeCredentialMatches('v1', expected, v1({ ...stored, refresh: 'real-refresh' }))).toBe(false);
    expect(await nativeCredentialMatches('v1', expected, v1({ ...stored, access: 'other' }))).toBe(false);
    expect(await nativeCredentialMatches('v1', expected, v1({ ...stored, expires: 124 }))).toBe(false);
    expect(await nativeCredentialMatches('v1', expected, { file: () => null, credentials: async () => api(null) })).toBe(false);
    expect(await nativeCredentialMatches('v1', null, v1(stored))).toBe(false);
    const v2 = (list: any, status = 200) => ({ file: () => null, credentials: async () => api({ data: list }, status) });
    const entry = { integrationID: 'openai', value: { access: FAKE_ACCESS, refresh: REFRESH_SENTINEL, expires: 123, metadata: { accountID: FAKE_ACCOUNT } } };
    expect(await nativeCredentialMatches('v2', expected, v2([entry]))).toBe(true);
    expect(await nativeCredentialMatches('v2', expected, v2([entry, entry]))).toBe(false);
    expect(await nativeCredentialMatches('v2', expected, v2([entry], 500))).toBe(false);
  });

  test('only direct native plan read and approval parts count; Code Mode execute never does, whatever its code or output', () => {
    const plan = (revision: string) => JSON.stringify({ revision, contentHash: 'h', status: 'planning', content: 'c', comments: [] });
    const approvalOutput = (revision: string) => JSON.stringify({ approval: { success: true, revision }, sync: { success: true } });
    const tree = { sessions: [{ id: 'ses_a', parentId: null, agent: null }], complete: true, failure: null };
    const history = { complete: true, failure: null, messages: [
      normalizeMessage('v1', msgV1('m1', 'assistant', [{ id: 'c1', name: 'hive_plan_read', input: { feature: 'f' }, output: plan('r1') }]))!,
      normalizeMessage('v1', msgV1('m2', 'assistant', [{ id: 'c2', name: 'hive_plan_read', input: { feature: 'other' }, output: plan('rx') }]))!,
      normalizeMessage('v1', msgV1('m3', 'assistant', [{ id: 'c3', name: 'hive_plan_approve', input: { feature: 'f', expectedRevision: 'r1', sync: true }, output: approvalOutput('r1a') }]))!,
      // Later Code Mode parts: a call written in code, one only in a comment, and dead code; each returns a well-formed
      // plan read or approval the model could have typed.
      normalizeMessage('v1', msgV1('m4', 'assistant', [{ id: 'c4', name: 'execute', input: { code: "return await tools.hive_plan_read({ feature: 'f' })" }, output: JSON.stringify({ result: plan('r2') }) }]))!,
      normalizeMessage('v1', msgV1('m5', 'assistant', [{ id: 'c5', name: 'execute', input: { code: "// tools.hive_plan_approve({ feature: 'f', expectedRevision: 'r2', sync: true })\nreturn null" }, output: approvalOutput('r2a') }]))!,
      normalizeMessage('v1', msgV1('m6', 'assistant', [{ id: 'c6', name: 'execute', input: { code: "if (false) tools.hive_plan_read({ feature: 'f' }); return 1" }, output: plan('r3') }]))!,
    ] };
    const histories = new Map([['ses_a', history]]);
    expect(latestPluginPlanRead(tree, histories as any, 'f')).toMatchObject({ sessionId: 'ses_a', messageId: 'm1', callId: 'c1', result: { revision: 'r1' } });
    expect(observedApprovals(tree, histories as any)).toEqual([expect.objectContaining({ callId: 'c3', expectedRevision: 'r1', approvalSuccess: true, approvalRevision: 'r1a', syncSuccess: true })]);
    // Without the direct parts nothing is found, and a direct output in the Code Mode wrapper shape is not unwrapped.
    const onlyCode = new Map([['ses_a', { ...history, messages: history.messages.slice(3) }]]);
    expect(latestPluginPlanRead(tree, onlyCode as any, 'f')).toBeNull();
    expect(observedApprovals(tree, onlyCode as any)).toEqual([]);
    const wrapped = new Map([['ses_a', { ...history, messages: [normalizeMessage('v1', msgV1('m7', 'assistant', [{ id: 'c7', name: 'hive_plan_read', input: { feature: 'f' }, output: JSON.stringify({ result: plan('r9') }) }]))!] }]]);
    expect(latestPluginPlanRead(tree, wrapped as any, 'f')).toBeNull();
  });

  test('a fabricated Code Mode approval never satisfies the approval, read or switch checks, even when the core plan really is approved', async () => {
    const tree = { sessions: [{ id: 'ses_a', parentId: null, agent: null }], complete: true, failure: null };
    const forged = { id: 'c9', name: 'execute', status: 'completed', input: { code: "/* tools.hive_plan_approve({ feature: 'f', expectedRevision: 'r1', sync: true }) */ return 'ok'" }, output: JSON.stringify({ result: JSON.stringify({ approval: { success: true, revision: 'r1-approved' }, sync: { success: true } }) }) };
    const forgedRead = { id: 'c8', name: 'execute', status: 'completed', input: { code: "return await tools.hive_plan_read({ feature: 'f' })" }, output: JSON.stringify({ result: JSON.stringify({ revision: 'r1-approved', contentHash: 'h-r1', status: 'approved', content: 'c', comments: [] }) }) };
    const histories = new Map<string, any>([['ses_a', { complete: true, failure: null, messages: [msgV1('msg_decision', 'user'), msgV1('m2', 'assistant', [forgedRead, forged])].map((m) => normalizeMessage('v1', m)!) }]]);
    const bound = { messageId: 'msg_decision', feature: 'f', revision: 'r1', contentHash: 'h-r1' };
    // The core reads the plan as approved, with the decided content and the revision the forged output names.
    const core = async () => ({ ok: true, result: { revision: 'r1-approved', contentHash: 'h-r1', status: 'approved' } });
    expect(approvalObserved(tree, histories, bound)).toBeNull();
    expect(await approvalPrecondition(tree, histories, bound, core)).toEqual({ failure: 'approval_not_observed' });
    expect(latestPluginPlanRead(tree, histories, 'f')).toBeNull();
    expect(observedApprovals(tree, histories)).toEqual([]);
  });

  test('only the actual primary session\'s latest full read of the named feature counts, whatever a reviewer child read later', () => {
    const plan = (revision: string, extra: any = {}) => JSON.stringify({ revision, contentHash: `h-${revision}`, status: 'planning', content: 'c', comments: [], ...extra });
    const read = (id: string, output: string, input: any = { feature: 'f' }) => ({ id, name: 'hive_plan_read', input, output });
    const tree = { sessions: [{ id: 'ses_a', parentId: null, agent: null }, { id: 'ses_b', parentId: 'ses_a', agent: null }], complete: true, failure: null };
    const history = (messages: any[]) => ({ complete: true, failure: null, messages: messages.map((m) => normalizeMessage('v1', m)!) });
    // The primary reads r1, a reviewer child reads r1, a later amendment changes the plan and the primary rereads r2.
    // The child sorts after the primary in the tree, so its older read must not replace the primary's newer one.
    const histories = new Map([
      ['ses_a', history([msgV1('m1', 'assistant', [read('c1', plan('r1'))]), msgV1('m5', 'assistant', [read('c5', plan('r2'))])])],
      ['ses_b', history([msgV1('m2', 'assistant', [read('c2', plan('r1'))])])],
    ]);
    expect(latestPluginPlanRead(tree, histories as any, 'f')).toMatchObject({ sessionId: 'ses_a', messageId: 'm5', callId: 'c5', result: { revision: 'r2' } });
    expect(latestPluginPlanRead(tree, new Map([['ses_a', history([])], ['ses_b', histories.get('ses_b')!]]) as any, 'f')).toBeNull();
    const primaryOnly = (...tools: any[]) => latestPluginPlanRead(tree, new Map([['ses_a', history([msgV1('m', 'assistant', tools)])]]) as any, 'f');
    expect(primaryOnly(read('c', plan('r1'), { feature: 'f', mode: 'outline' }))).toBeNull();
    expect(primaryOnly(read('c', plan('r1'), {}))).toBeNull();
    expect(primaryOnly(read('c', plan('r1'), { feature: 'g' }))).toBeNull();
    expect(primaryOnly(read('c', JSON.stringify({ revision: 'r1', contentHash: 'h', status: 'planning' })))).toBeNull();
    expect(primaryOnly({ ...read('c', plan('r1')), status: 'running' })).toBeNull();
    expect(primaryOnly(read('c', plan('r1'), { feature: 'f', mode: 'full' }))).toMatchObject({ callId: 'c' });
  });

  test('an approval binds the primary session, the feature, the supervisor decision message and the revision', () => {
    const approve = (id: string, input: any, output: any = { approval: { success: true, revision: 'r1-approved' }, sync: { success: true } }, status = 'completed') => ({ id, name: 'hive_plan_approve', status, input, output: JSON.stringify(output) });
    const tree = { sessions: [{ id: 'ses_a', parentId: null, agent: null }, { id: 'ses_b', parentId: 'ses_a', agent: null }], complete: true, failure: null };
    const build = (primary: any[], child: any[] = []) => new Map<string, any>([
      ['ses_a', { complete: true, failure: null, messages: primary.map((m) => normalizeMessage('v1', m)!) }],
      ['ses_b', { complete: true, failure: null, messages: child.map((m) => normalizeMessage('v1', m)!) }],
    ]);
    const good = { feature: 'f', expectedRevision: 'r1', sync: true };
    const binding = { messageId: 'msg_decision', feature: 'f', revision: 'r1' };
    const decision = msgV1('msg_decision', 'user');
    expect(approvalObserved(tree, build([decision, msgV1('m2', 'assistant', [approve('c1', good)])]), binding)).toMatchObject({ callId: 'c1', approvalRevision: 'r1-approved' });
    // Identical plans in two features share a revision: another feature's approval is not this feature's.
    expect(approvalObserved(tree, build([decision, msgV1('m2', 'assistant', [approve('c1', { ...good, feature: 'g' })])]), binding)).toBeNull();
    expect(approvalObserved(tree, build([decision, msgV1('m2', 'assistant', [approve('c1', { ...good, feature: 'g' })])]), { ...binding, feature: 'g' })).toMatchObject({ callId: 'c1' });
    // An approval from before the decision message, from a child session, or without that message does not count.
    expect(approvalObserved(tree, build([msgV1('m0', 'assistant', [approve('c0', good)]), decision]), binding)).toBeNull();
    expect(approvalObserved(tree, build([decision], [msgV1('m3', 'assistant', [approve('c3', good)])]), binding)).toBeNull();
    expect(approvalObserved(tree, build([msgV1('m2', 'assistant', [approve('c1', good)])]), binding)).toBeNull();
    for (const [input, output, status] of [
      [{ ...good, expectedRevision: 'r0' }], [{ feature: 'f', expectedRevision: 'r1' }], [good, { approval: { success: true, revision: 'x' }, sync: { success: false } }],
      [good, { approval: { success: false }, sync: { success: true } }], [good, undefined, 'error'],
    ] as any[]) {
      expect(approvalObserved(tree, build([decision, msgV1('m2', 'assistant', [approve('c1', input, output, status)])]), binding)).toBeNull();
    }
    const viaCode = { id: 'c9', name: 'execute', input: { code: "return await tools.hive_plan_approve({ feature: 'f', expectedRevision: 'r1', sync: true })" }, output: JSON.stringify({ result: JSON.stringify({ approval: { success: true, revision: 'r1-approved' }, sync: { success: true } }) }) };
    expect(approvalObserved(tree, build([decision, msgV1('m2', 'assistant', [viaCode])]), binding)).toBeNull();
  });

  test('a switch needs the plan to still be the approved one: approve, rewrite, then switch is refused', async () => {
    const tree = { sessions: [{ id: 'ses_a', parentId: null, agent: null }], complete: true, failure: null };
    const approval = { id: 'c1', name: 'hive_plan_approve', status: 'completed', input: { feature: 'f', expectedRevision: 'r1', sync: true }, output: JSON.stringify({ approval: { success: true, revision: 'r1-approved' }, sync: { success: true } }) };
    const histories = new Map<string, any>([['ses_a', { complete: true, failure: null, messages: [msgV1('msg_decision', 'user'), msgV1('m2', 'assistant', [approval])].map((m) => normalizeMessage('v1', m)!) }]]);
    const bound = { messageId: 'msg_decision', feature: 'f', revision: 'r1', contentHash: 'h-r1' };
    const core = (over: any = {}) => async () => ({ ok: true, result: { revision: 'r1-approved', contentHash: 'h-r1', status: 'approved', ...over } });
    expect(await approvalPrecondition(tree, histories, bound, core())).toBeNull();
    // The primary rewrites the plan after approving: the write revokes approval and changes the content.
    expect(await approvalPrecondition(tree, histories, bound, core({ status: 'planning', contentHash: 'h-new', revision: 'r2' }))).toEqual({ failure: 'plan_not_approved' });
    // Approved again with different content, or a new comment after approval: not the plan the supervisor decided on.
    expect(await approvalPrecondition(tree, histories, bound, core({ contentHash: 'h-new' }))).toEqual({ failure: 'plan_changed', extra: { currentRevision: 'r1-approved' } });
    expect(await approvalPrecondition(tree, histories, bound, core({ revision: 'r1-approved-with-comment' }))).toEqual({ failure: 'plan_changed', extra: { currentRevision: 'r1-approved-with-comment' } });
    expect(await approvalPrecondition(tree, histories, { ...bound, feature: 'g' }, core())).toEqual({ failure: 'approval_not_observed' });
    expect(await approvalPrecondition(tree, histories, bound, async () => ({ ok: false, failure: 'plan_missing' }))).toEqual({ failure: 'plan_missing' });
    const unknownRevision = new Map<string, any>([['ses_a', { complete: true, failure: null, messages: [msgV1('msg_decision', 'user'), msgV1('m2', 'assistant', [{ ...approval, output: JSON.stringify({ approval: { success: true }, sync: { success: true } }) }])].map((m) => normalizeMessage('v1', m)!) }]]);
    expect(await approvalPrecondition(tree, unknownRevision, bound, core())).toEqual({ failure: 'approval_revision_unknown' });
  });

  test('a lost acknowledgement resolves only from native evidence that names the exact operation', async () => {
    const question = (status: string, answers?: any) => ({ info: { id: 'm', role: 'assistant', agent: 'a' }, parts: [{ type: 'tool', callID: 'call_q', tool: 'question', state: { status, input: {}, output: '', metadata: answers === undefined ? {} : { answers } } }] });
    const histories = (status: string, answers?: any) => new Map([['ses_b', { messages: [normalizeMessage('v1', question(status, answers))!], complete: true, failure: null }]]);
    const prompt = { kind: 'prompt', sessionId: 'ses_a', messageId: 'msg_000000000001AAAAAAAAAAAAAA' };
    const message = (info: any) => routeGet({ '/session/ses_a/message/msg_000000000001AAAAAAAAAAAAAA': api({ info, parts: [] }) });
    expect(await resolveOperation('v1', prompt, {}, message({ id: prompt.messageId, role: 'user' }))).toEqual({ resolved: true, effect: 'accepted' });
    expect(await resolveOperation('v1', prompt, {}, routeGet({}))).toEqual({ resolved: false });
    expect(await resolveOperation('v1', prompt, {}, message({ id: 'msg_other', role: 'user' }))).toEqual({ resolved: false });
    expect(await resolveOperation('v1', prompt, {}, message({ id: prompt.messageId, role: 'assistant' }))).toEqual({ resolved: false });
    // v1 question reply: the exact tool call, in the session that asked, completed with exactly the answers that were sent.
    const reply = { kind: 'question-reply', requestId: 'que_1', ownerSessionId: 'ses_b', toolCallId: 'call_q', answers: [['alpha']] };
    expect(await resolveOperation('v1', reply, { histories: histories('completed', [['alpha']]) }, routeGet({}))).toEqual({ resolved: true, effect: 'accepted' });
    // A completed matching call in another session answers another question: with the owner's own call still pending,
    // with a second call of that ID in the owner, a call that is not a question, or an owner history read incompletely,
    // nothing is resolved.
    const call = (session: string, status: string, answers: any, tool = 'question') => [session, { messages: [normalizeMessage('v1', { info: { id: `m_${session}`, role: 'assistant', agent: 'a' }, parts: [{ type: 'tool', callID: 'call_q', tool, state: { status, input: {}, output: '', metadata: { answers } } }] })!], complete: true, failure: null }] as const;
    expect(await resolveOperation('v1', reply, { histories: new Map([call('ses_other', 'completed', [['alpha']]), call('ses_b', 'running', undefined)]) }, routeGet({}))).toEqual({ resolved: false });
    expect(await resolveOperation('v1', reply, { histories: new Map([call('ses_other', 'completed', [['alpha']])]) }, routeGet({}))).toEqual({ resolved: false });
    expect(await resolveOperation('v1', { ...reply, ownerSessionId: undefined }, { histories: new Map([call('ses_b', 'completed', [['alpha']])]) }, routeGet({}))).toEqual({ resolved: false });
    const twice = new Map([['ses_b', { messages: [...call('ses_b', 'completed', [['alpha']])[1].messages, ...call('ses_b', 'running', undefined)[1].messages], complete: true, failure: null }]]);
    expect(await resolveOperation('v1', reply, { histories: twice }, routeGet({}))).toEqual({ resolved: false });
    expect(await resolveOperation('v1', reply, { histories: new Map([call('ses_b', 'completed', [['alpha']], 'bash')]) }, routeGet({}))).toEqual({ resolved: false });
    expect(await resolveOperation('v1', reply, { histories: new Map([['ses_b', { ...call('ses_b', 'completed', [['alpha']])[1], complete: false }]]) }, routeGet({}))).toEqual({ resolved: false });
    expect(await resolveOperation('v1', reply, { histories: histories('completed', [['beta']]) }, routeGet({}))).toEqual({ resolved: false });
    expect(await resolveOperation('v1', reply, { histories: histories('running', [['alpha']]) }, routeGet({}))).toEqual({ resolved: false });
    expect(await resolveOperation('v1', reply, { histories: histories('completed') }, routeGet({}))).toEqual({ resolved: false });
    // A request still pending, one that vanished, or an unreadable list is no proof about this reply: it may yet be applied late.
    expect(await resolveOperation('v1', reply, { pending: [{ id: 'que_1' }], histories: histories('pending') }, routeGet({}))).toEqual({ resolved: false });
    expect(await resolveOperation('v1', reply, { pending: [], histories: histories('running') }, routeGet({}))).toEqual({ resolved: false });
    expect(await resolveOperation('v1', reply, { pending: null, histories: histories('running') }, routeGet({}))).toEqual({ resolved: false });
    // v2 form reply: the exact form is answered with exactly those answers.
    const form = { kind: 'question-reply', requestId: 'frm_1', ownerSessionId: 'ses_a', answers: [['alpha'], ['x', 'y']] };
    const formState = (state: any) => routeGet({ '/api/session/ses_a/form/frm_1': api({ data: { state } }) });
    expect(await resolveOperation('v2', form, {}, formState({ status: 'answered', answer: { q0: 'alpha', q1: ['x', 'y'] } }))).toEqual({ resolved: true, effect: 'accepted' });
    expect(await resolveOperation('v2', form, {}, formState({ status: 'answered', answer: { q0: 'beta', q1: ['x', 'y'] } }))).toEqual({ resolved: false });
    expect(await resolveOperation('v2', form, {}, formState({ status: 'answered', answer: { q0: 'alpha' } }))).toEqual({ resolved: false });
    expect(await resolveOperation('v2', form, {}, formState({ status: 'cancelled' }))).toEqual({ resolved: false });
    expect(await resolveOperation('v2', form, {}, formState({ status: 'pending' }))).toEqual({ resolved: false });
    // A permission reply or an interrupt leaves no record that names it, on either host, whatever the session looks like afterwards.
    const permission = { kind: 'permission-reply', requestId: 'per_1', toolCallId: 'call_r', decision: 'once' };
    expect(await resolveOperation('v1', permission, { pending: [{ id: 'per_1' }], histories: histories('pending') }, routeGet({}))).toEqual({ resolved: false });
    expect(await resolveOperation('v1', permission, { pending: [], histories: histories('running') }, routeGet({}))).toEqual({ resolved: false });
    expect(await resolveOperation('v2', permission, { pending: [] }, routeGet({}))).toEqual({ resolved: false });
    for (const host of ['v1', 'v2']) {
      expect(await resolveOperation(host, { kind: 'interrupt', sessionId: 'ses_a' }, { busy: new Set() }, routeGet({}))).toEqual({ resolved: false });
      expect(await resolveOperation(host, { kind: 'interrupt', sessionId: 'ses_a' }, { busy: null }, routeGet({}))).toEqual({ resolved: false });
    }
    // v2 switch: the session already runs the target and the previous primary was a different one.
    const sw = { kind: 'switch', sessionId: 'ses_a', agent: 'swarm-orchestrator', from: 'architect-planner' };
    const session = (agent: string) => routeGet({ '/api/session/ses_a': api({ data: { id: 'ses_a', agent } }) });
    expect(await resolveOperation('v2', sw, {}, session('swarm-orchestrator'))).toEqual({ resolved: true, effect: 'accepted' });
    expect(await resolveOperation('v2', sw, {}, session('architect-planner'))).toEqual({ resolved: false });
    expect(await resolveOperation('v2', { ...sw, from: undefined }, {}, session('swarm-orchestrator'))).toEqual({ resolved: false });
    expect(await resolveOperation('v2', { ...sw, from: 'swarm-orchestrator' }, {}, session('swarm-orchestrator'))).toEqual({ resolved: false });
    expect(await resolveOperation('v1', sw, {}, session('swarm-orchestrator'))).toEqual({ resolved: false });
  });

  test('the driver never consults an agent-writable credential marker and emits fixed failure codes only', () => {
    const source = readFileSync(join(import.meta.dir, 'exercise-driver.ts'), 'utf8');
    expect(source).not.toContain('access.sha256');
    expect(source).not.toMatch(/runPrompt|error\.message|error\.stack|error\)\?\.name/);
    const run = (command: string, input: string) => JSON.parse(spawnSync(process.execPath, [join(import.meta.dir, 'exercise-driver.ts'), command], { input, encoding: 'utf8' }).stdout.trim());
    expect(run('unknown', '{}')).toEqual({ ok: false, failure: 'unknown_command' });
    expect(run('observe', 'not json')).toEqual({ ok: false, failure: 'input_malformed' });
    expect(run('observe', '{"host":"v9"}')).toEqual({ ok: false, failure: 'input_malformed' });
  });

  test('diffs come from snapshot content, not Git diff drivers', () => {
    expect(lineDiff('a.txt', 'one\ntwo\n', 'one\nTWO\n')).toBe('--- a/a.txt\n+++ b/a.txt\n@@ -2,1 +2,1 @@\n-two\n+TWO\n');
    expect(lineDiff('a.txt', 'same', 'same')).toBe('');
    expect(lineDiff('new.txt', null, 'x')).toContain('+x');
    expect(readFileSync(join(import.meta.dir, 'exercise-driver.ts'), 'utf8')).not.toMatch(/'diff'|textconv|ext-diff/);
  });
});

describe('supervised exercise candidate-core plan reader', () => {
  function project() {
    const root = scratch();
    const feature = join(root, '.hive', 'features', '01_feat');
    mkdirSync(feature, { recursive: true });
    writeFileSync(join(feature, 'plan.md'), '# Plan\n');
    const core = (featurePath = feature) => async () => ({
      getFeaturePath: () => featurePath,
      getPlanPath: () => join(featurePath, 'plan.md'),
      PlanService: class { read() { return { revision: 'r1', contentHash: 'h1', status: 'planning', content: '# Plan\n', comments: [] }; } },
    });
    return { root, feature, core };
  }

  test('reads one feature through the public core API after containment and size checks', async () => {
    const { root, core } = project();
    expect(await readPlan(root, 'feat', core() as any)).toEqual({ ok: true, featurePath: '.hive/features/01_feat', planPath: '.hive/features/01_feat/plan.md', result: { revision: 'r1', contentHash: 'h1', status: 'planning', content: '# Plan\n', comments: [] } });
  });

  test('refuses invalid names, missing or unusable cores, escaping or linked feature paths and oversize plans', async () => {
    const { root, feature, core } = project();
    expect(await readPlan(root, '../feat', core() as any)).toEqual({ ok: false, failure: 'feature_name_invalid' });
    expect(await readPlan(root, 'feat', (async () => { throw new Error('missing'); }) as any)).toEqual({ ok: false, failure: 'core_unavailable' });
    expect(await readPlan(root, 'feat', (async () => ({ getFeaturePath: () => feature })) as any)).toEqual({ ok: false, failure: 'core_unavailable' });
    const outside = scratch();
    writeFileSync(join(outside, 'plan.md'), 'x');
    expect(await readPlan(root, 'feat', core(outside) as any)).toEqual({ ok: false, failure: 'feature_path_escapes' });
    spawnSync('ln', ['-s', outside, join(root, '.hive', 'features', '02_link')]);
    expect(await readPlan(root, 'feat', core(join(root, '.hive', 'features', '02_link')) as any)).toEqual({ ok: false, failure: 'feature_path_escapes' });
    writeFileSync(join(feature, 'plan.md'), 'x'.repeat(256 * 1024 + 1));
    expect(await readPlan(root, 'feat', core() as any)).toEqual({ ok: false, failure: 'plan_oversize' });
  });

  test('every input of the public read is bounded and regular before the core opens it: metadata, comments, approval marker and ancestors', async () => {
    const check = async (mutate: (p: ReturnType<typeof project>) => void) => { const p = project(); mutate(p); return readPlan(p.root, 'feat', p.core() as any); };
    const big = (n: number) => 'x'.repeat(n + 1);
    const rejected = { ok: false, failure: 'plan_input_rejected' };
    const oversize = { ok: false, failure: 'plan_input_oversize' };
    const otherFeature = (root: string) => { const dir = join(root, '.hive', 'features', '02_other'); mkdirSync(dir); return dir; };
    // feature.json of the feature, and of any other the core may list while resolving the name
    expect(await check(({ feature }) => writeFileSync(join(feature, 'feature.json'), big(PLAN_READ_LIMITS.metadataBytes)))).toEqual(oversize);
    expect(await check(({ root }) => writeFileSync(join(otherFeature(root), 'feature.json'), big(PLAN_READ_LIMITS.metadataBytes)))).toEqual(oversize);
    expect(await check(({ root }) => symlinkSync('/etc/hostname', join(otherFeature(root), 'feature.json')))).toEqual(rejected);
    expect(await check(({ root, feature }) => { writeFileSync(join(feature, 'feature.json'), '{}'); linkSync(join(feature, 'feature.json'), join(otherFeature(root), 'feature.json')); })).toEqual(rejected);
    // canonical and legacy review comments
    expect(await check(({ feature }) => { mkdirSync(join(feature, 'comments')); writeFileSync(join(feature, 'comments', 'plan.json'), big(PLAN_READ_LIMITS.commentsBytes)); })).toEqual(oversize);
    expect(await check(({ feature }) => writeFileSync(join(feature, 'comments.json'), big(PLAN_READ_LIMITS.commentsBytes)))).toEqual(oversize);
    expect(await check(({ feature }) => { mkdirSync(join(feature, 'comments')); symlinkSync('/etc/hostname', join(feature, 'comments', 'plan.json')); })).toEqual(rejected);
    expect(await check(({ feature }) => symlinkSync('/etc/hostname', join(feature, 'comments.json')))).toEqual(rejected);
    expect(await check(({ feature }) => { writeFileSync(join(feature, 'comments.json'), '{}'); linkSync(join(feature, 'comments.json'), join(feature, 'copy.json')); })).toEqual(rejected);
    expect(await check(({ feature }) => symlinkSync('/etc', join(feature, 'comments')))).toEqual(rejected);
    expect(await check(({ feature }) => writeFileSync(join(feature, 'comments'), 'not a directory'))).toEqual(rejected);
    expect(await check(({ feature }) => spawnSync('mkfifo', [join(feature, 'comments.json')]))).toEqual(rejected);
    expect(await check(({ feature }) => symlinkSync('/etc/hostname', join(feature, 'APPROVED')))).toEqual(rejected);
    expect(await check(({ feature }) => writeFileSync(join(feature, 'APPROVED'), big(PLAN_READ_LIMITS.markerBytes)))).toEqual(oversize);
    expect(await check(({ feature }) => { writeFileSync(join(feature, 'plan.md'), '# Plan\n'); linkSync(join(feature, 'plan.md'), join(feature, 'copy.md')); })).toEqual({ ok: false, failure: 'plan_not_regular' });
    // The bounds are inclusive and ordinary inputs pass untouched.
    expect(await check(({ feature }) => { mkdirSync(join(feature, 'comments')); writeFileSync(join(feature, 'comments', 'plan.json'), 'x'.repeat(PLAN_READ_LIMITS.commentsBytes)); writeFileSync(join(feature, 'feature.json'), '{"name":"feat"}'); writeFileSync(join(feature, 'APPROVED'), '2026-01-01'); })).toMatchObject({ ok: true });
    // An ancestor that is a link, even to a tree that contains the feature, leaves the project.
    const escaped = await (async () => {
      const p = project();
      const outside = scratch();
      mkdirSync(join(outside, 'features', '01_feat'), { recursive: true });
      writeFileSync(join(outside, 'features', '01_feat', 'plan.md'), '# Plan\n');
      spawnSync('rm', ['-rf', join(p.root, '.hive', 'features')]);
      symlinkSync(join(outside, 'features'), join(p.root, '.hive', 'features'));
      return readPlan(p.root, 'feat', p.core(join(p.root, '.hive', 'features', '01_feat')) as any);
    })();
    expect(escaped).toEqual({ ok: false, failure: 'feature_path_escapes' });
    const hiveLinked = await (async () => {
      const p = project();
      const outside = scratch();
      spawnSync('mv', [join(p.root, '.hive'), join(outside, '.hive')]);
      symlinkSync(join(outside, '.hive'), join(p.root, '.hive'));
      return readPlan(p.root, 'feat', p.core(join(p.root, '.hive', 'features', '01_feat')) as any);
    })();
    expect(hiveLinked).toEqual({ ok: false, failure: 'feature_path_escapes' });
    // A feature directory count beyond the bound is refused rather than listed without limit.
    expect(await check(({ root }) => { for (let i = 0; i < PLAN_READ_LIMITS.featureDirectories + 1; i++) mkdirSync(join(root, '.hive', 'features', `x${i}`)); })).toEqual(oversize);
  });

  test('parity compares revision, content hash, status, content and comments', () => {
    const a = { revision: 'r', contentHash: 'h', status: 'planning', content: 'c', comments: [] };
    expect(planReadDifferences(a, { ...a })).toEqual([]);
    expect(planReadDifferences(a, { ...a, comments: [{ id: 'x' }] })).toEqual(['comments']);
    expect(planReadDifferences(a, { ...a, revision: 's', status: 'approved' })).toEqual(['revision', 'status']);
  });
});

// The run commands against an in-memory guard and driver. Each fake run is a started, credentialed run directory. The
// guard reports its clock (`clockMs`, a fixed reading unless a test moves it) and its deadline on that clock.
class ExerciseDocker extends FakeDocker {
  driverCalls: { command: string; input: any }[] = [];
  compares: boolean[] = [];
  remainingSeq: number[] = [];
  clockMs = 5_000_000;

  async run(args: string[], options: any = {}) {
    if (args[0] === 'exec' && args.includes('/opt/ic/harness/guard.mjs')) {
      this.calls.push({ args, input: options.input });
      const op = args[args.indexOf('/opt/ic/harness/guard.mjs') + 1];
      const clock = (remainingMs: number) => ({ clockMs: this.clockMs, deadlineClockMs: this.clockMs + remainingMs });
      if (op === 'compare') {
        const matches = this.compares.length ? this.compares.shift()! : this.behavior.matches ?? true;
        const remainingMs = this.remainingSeq.length ? this.remainingSeq.shift()! : this.behavior.remainingMs ?? 900_000;
        return this.ok(JSON.stringify({ ok: true, matches, remainingMs, ...clock(remainingMs) }));
      }
      const remainingMs = this.behavior.remainingMs ?? 900_000;
      return this.ok(JSON.stringify({ ok: true, armed: true, remainingMs, ...clock(remainingMs) }));
    }
    if (args[0] === 'exec' && args.includes('/opt/ic/harness/exercise-driver.ts')) {
      this.calls.push({ args, input: options.input });
      const command = args.at(-1)!;
      const input = JSON.parse(options.input);
      this.driverCalls.push({ command, input });
      if (this.behavior.timeout?.includes(command)) return { code: -1, stdout: '', stderr: '', timedOut: true };
      const reply = (await this.behavior.driver?.[command]?.(input)) ?? { ok: true };
      return this.ok(typeof reply === 'string' ? reply : JSON.stringify(reply));
    }
    return super.run(args, options);
  }
}

function exerciseRun({ host = 'v1', expires = Date.now() + 4 * 3_600_000, ledger = null as string | null, name = null as string | null } = {}) {
  const runDir = name ? join(scratch(), name) : scratch();
  if (name) mkdirSync(runDir);
  mkdirSync(join(runDir, 'inputs'));
  mkdirSync(join(runDir, 'docker-config'));
  writeFileSync(join(runDir, 'lock'), '');
  const containerId = 'c'.repeat(64);
  writeFileSync(join(runDir, 'resources.jsonl'), ledger ?? [
    { event: 'create_requested', kind: 'container', nonce: 'n1' }, { event: 'created', kind: 'container', nonce: 'n1', id: containerId },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const request = validateRequest(EXERCISE_REQUEST);
  writeFileSync(join(runDir, 'inputs', 'snapshot.json'), JSON.stringify({ schema: 'ic-exercise-snapshot/v1', request, files: [{ path: 'README.md', sha256: 'x', content: 'hello\n' }], prompt: 'p', brief: null, skills: {} }));
  const journal = Journal.create(join(runDir, 'records'));
  journal.write('input', { snapshotSha256: createHash('sha256').update(readFileSync(join(runDir, 'inputs', 'snapshot.json'))).digest('hex'), lockInode: String(statSync(join(runDir, 'lock')).ino) });
  journal.write('prepared', { schema: 'ic-exercise-prepared/v1', status: 'prepared', runId: 'run-1', host, request, docker: { endpoint: 'unix:///fake.sock', engineId: ENGINE }, runtime: { imageId: 'sha256:image' } });
  journal.write('authorization', { allowedActions: ACTIONS });
  journal.write('start.container', { id: containerId });
  journal.write('start.armed', { deadlineAt: Date.now() + 900_000 });
  journal.write('start.inject', {});
  journal.write('start.session', { sessionId: 'ses_primary', agent: 'architect-planner', model: { ref: 'openai/gpt-test', variant: null }, containerId });
  const auth = authFile({ type: 'oauth', access: FAKE_ACCESS, refresh: FAKE_REFRESH, expires, accountId: FAKE_ACCOUNT });
  let n = 0;
  const file = (value: any) => { const path = join(runDir, `input-${++n}.json`); writeFileSync(path, JSON.stringify(value)); return path; };
  return {
    runDir, journal, auth, env: { IC_EXERCISE_AUTH_PATH: auth },
    op: (action: string, fields: any = {}, id = `op-${n + 1}`) => file({ schema: 'ic-exercise-operation/v1', id, runId: 'run-1', sessionId: 'ses_primary', action, ...fields }),
    inspection: (fields: any = {}) => file({ schema: 'ic-exercise-inspection/v1', runId: 'run-1', ...fields }),
  };
}

const QUIET = { ok: true, quiescent: true, reasons: [], pending: [], approvals: [], tree: { sessions: [], complete: true, failure: null }, busy: [] };
/** Pending interactions in the form the driver releases: sizes equal to the texts and `complete` true. */
const released = (...raw: any[]) => releasedPending(raw, () => false);

describe('supervised exercise run commands', () => {
  const submits = (docker: ExerciseDocker) => docker.driverCalls.filter((c) => c.command === 'submit');

  test('a lost acknowledgement is unknown, blocks every further submission without replay, and resolves only by exact message ID', async () => {
    const docker = new ExerciseDocker({ driver: { submit: () => ({ ok: true, submitted: true, acknowledged: null }) } });
    const run = exerciseRun();
    const lost = await turnCommand({ run: run.runDir, operation: run.op('prompt', { text: 'plan it' }, 'p1') }, run.env, {}, { docker });
    expect(lost.exit).toBe(EXIT.busy);
    expect(lost.status).toMatchObject({ state: 'unknown', reason: 'acknowledgement_lost' });
    const sent = submits(docker)[0].input.op;
    expect(sent.messageId).toMatch(MESSAGE_ID);
    expect(run.journal.read('op.0001.intent')!.value).toMatchObject({ id: 'p1', kind: 'prompt', messageId: sent.messageId, sessionId: 'ses_primary' });
    const again = await turnCommand({ run: run.runDir, operation: run.op('prompt', { text: 'plan it' }, 'p2') }, run.env, {}, { docker });
    expect(again).toMatchObject({ exit: EXIT.busy, status: { status: 'blocked', reason: 'operation_unresolved', unresolved: ['p1'] } });
    expect(submits(docker).length).toBe(1);
    docker.behavior.driver.observe = (input: any) => ({ ...QUIET, resolution: input.resolve?.messageId === sent.messageId ? { resolved: true, effect: 'accepted' } : { resolved: false } });
    const resolved = await inspectCommand({ run: run.runDir, request: run.inspection({ resolve: 'p1' }) }, run.env, { docker });
    expect(resolved.status.resolution).toEqual({ resolved: true, effect: 'accepted' });
    expect(run.journal.read('op.0001.resolution')!.value).toMatchObject({ resolved: true, effect: 'accepted' });
    expect(runState(run.journal).unresolved).toEqual([]);
    docker.behavior.driver.submit = () => ({ ok: true, submitted: true, acknowledged: true, status: 204 });
    expect((await turnCommand({ run: run.runDir, operation: run.op('prompt', { text: 'next' }, 'p3') }, run.env, {}, { docker })).exit).toBe(EXIT.ok);
    expect(submits(docker).length).toBe(2);
  });

  test('an unresolvable unknown stays unknown and cannot be resolved by a later inspect without exact evidence', async () => {
    const docker = new ExerciseDocker({ driver: { submit: () => 'not json', observe: () => ({ ...QUIET, resolution: { resolved: false } }) } });
    const run = exerciseRun();
    expect((await turnCommand({ run: run.runDir, operation: run.op('interrupt', {}, 'i1') }, run.env, {}, { docker })).status.state).toBe('unknown');
    await inspectCommand({ run: run.runDir, request: run.inspection({ resolve: 'i1' }) }, run.env, { docker });
    expect(runState(run.journal).unresolved).toEqual(['i1']);
  });

  test('a changed host auth file latches the run before any driver call; inspect then exports controller facts only', async () => {
    const docker = new ExerciseDocker({ matches: false, driver: { submit: () => ({ ok: true, submitted: true, acknowledged: true }) } });
    const run = exerciseRun();
    const refused = await turnCommand({ run: run.runDir, operation: run.op('prompt', { text: 'x' }) }, run.env, {}, { docker });
    expect(refused).toMatchObject({ exit: EXIT.failed, status: { status: 'refused', reason: 'run_latched', latch: 'host_auth_changed' } });
    expect(docker.driverCalls).toEqual([]);
    const inspected = await inspectCommand({ run: run.runDir, request: run.inspection({ conversation: {} }) }, run.env, { docker });
    expect(inspected.status).toMatchObject({ status: 'content_unavailable', lifecycle: { latched: 'host_auth_changed' } });
    expect(inspected.status).not.toHaveProperty('pending');
    expect(docker.driverCalls).toEqual([]);
  });

  test('a missing or unreadable host auth file and an insufficient expiry latch the run the same way', async () => {
    for (const [mutate, latch] of [[(r: any) => require('node:fs').unlinkSync(r.auth), 'auth_missing'], [(r: any) => writeFileSync(r.auth, '{bad'), 'auth_malformed']] as const) {
      const docker = new ExerciseDocker();
      const run = exerciseRun();
      mutate(run);
      // The bound fingerprint is not compared with a file that cannot be read: the snapshot itself refuses it.
      docker.behavior.matches = true;
      const result = await turnCommand({ run: run.runDir, operation: run.op('prompt', { text: 'x' }) }, run.env, {}, { docker });
      expect(result.status).toMatchObject({ status: 'refused', reason: 'run_latched' });
      expect([latch, 'host_auth_changed']).toContain(result.status.latch);
    }
    const docker = new ExerciseDocker({ remainingMs: 900_000 });
    const run = exerciseRun({ expires: Date.now() + 10 * 60_000 });
    const short = await turnCommand({ run: run.runDir, operation: run.op('prompt', { text: 'x' }) }, run.env, {}, { docker });
    expect(short.status).toMatchObject({ reason: 'run_latched', latch: 'lifetime_insufficient' });
    expect(docker.driverCalls).toEqual([]);
  });

  test('a failed postcheck leaves the accepted request possibly executed: unknown, latched, never replayed', async () => {
    const docker = new ExerciseDocker({ driver: { submit: () => ({ ok: true, submitted: true, acknowledged: true }) } });
    docker.compares = [true, true, false];
    const run = exerciseRun();
    const result = await turnCommand({ run: run.runDir, operation: run.op('prompt', { text: 'x' }, 'p1') }, run.env, {}, { docker });
    expect(result.status).toMatchObject({ state: 'unknown', reason: 'host_auth_changed', latched: true });
    expect(run.journal.read('latch')!.value.code).toBe('host_auth_changed');
    expect(runState(run.journal).unresolved).toEqual(['p1']);
  });

  test('a driver reply carrying a token fragment is discarded, latches the run and is never published', async () => {
    const fragment = FAKE_ACCESS.slice(2, 34);
    const docker = new ExerciseDocker({ driver: { submit: () => ({ ok: true, submitted: true, acknowledged: true, note: fragment }) } });
    const run = exerciseRun();
    const result = await turnCommand({ run: run.runDir, operation: run.op('prompt', { text: 'x' }) }, run.env, {}, { docker });
    expect(result.status).toMatchObject({ state: 'unknown', reason: 'content_unavailable', latched: true });
    expect(JSON.stringify(result)).not.toContain(fragment);
    expect(run.journal.read('latch')!.value.code).toBe('evidence_contaminated');
    for (const name of run.journal.names()) expect(JSON.stringify(run.journal.read(name))).not.toContain(fragment);
  });

  test('a driver that lost its scanner or saw a changed native credential latches the run the same way', async () => {
    for (const failure of ['scanner_unavailable', 'native_auth_changed']) {
      const docker = new ExerciseDocker({ driver: { submit: () => ({ ok: false, failure }), observe: () => ({ ok: false, failure }) } });
      const run = exerciseRun();
      expect((await turnCommand({ run: run.runDir, operation: run.op('prompt', { text: 'x' }) }, run.env, {}, { docker })).status).toMatchObject({ state: 'unknown', latched: true });
      expect(run.journal.read('latch')!.value.code).toBe(failure);
      const other = exerciseRun();
      const inspected = await inspectCommand({ run: other.runDir }, other.env, { docker });
      expect(inspected.status).toMatchObject({ status: 'content_unavailable' });
      expect(other.journal.read('latch')!.value.code).toBe(failure);
      expect(existsSync(join(other.runDir, 'evidence'))).toBe(false);
    }
  });

  test('a command on a missing run reports a fixed code', async () => {
    let out = '';
    const stdout = { write: (s: string) => { out = s; return true; } };
    expect(await exerciseMain(['stop', '--run', join(scratch(), 'absent')], { env: {}, stdout })).toBe(EXIT.invalid);
    expect(JSON.parse(out)).toMatchObject({ status: 'refused', reason: 'run_not_prepared' });
  });

  test('no new work is admitted in the final 60 s', async () => {
    const docker = new ExerciseDocker({ remainingMs: 59_000 });
    const run = exerciseRun();
    const result = await turnCommand({ run: run.runDir, operation: run.op('prompt', { text: 'x' }) }, run.env, {}, { docker });
    expect(result.status).toMatchObject({ state: 'refused', reason: 'no_new_work_window' });
    expect(submits(docker)).toEqual([]);
  });

  test('a reply records the exact pending request, owner and tool call before sending; a request not pending is refused unsent', async () => {
    const pending = released({ kind: 'question', id: 'que_1', sessionId: 'ses_child', toolCallId: 'call_q', questions: [{ question: 'Which?', header: null, multiple: false, options: ['alpha'], optionDescriptions: ['first'] }] });
    const docker = new ExerciseDocker({ driver: { observe: () => ({ ...QUIET, quiescent: false, pending }), submit: () => ({ ok: true, submitted: true, acknowledged: true }) } });
    const run = exerciseRun();
    expect((await turnCommand({ run: run.runDir, operation: run.op('reply', { requestId: 'que_9', answers: [['alpha']] }) }, run.env, {}, { docker })).status).toMatchObject({ state: 'refused', reason: 'request_not_pending' });
    expect(submits(docker)).toEqual([]);
    const ok = await turnCommand({ run: run.runDir, operation: run.op('reply', { requestId: 'que_1', answers: [['alpha']] }) }, run.env, {}, { docker });
    expect(ok.exit).toBe(EXIT.ok);
    expect(run.journal.read('op.0001.intent')!.value).toMatchObject({ kind: 'question-reply', requestId: 'que_1', ownerSessionId: 'ses_child', toolCallId: 'call_q', answers: [['alpha']] });
    expect(submits(docker)[0].input.op).toEqual({ kind: 'question-reply', requestId: 'que_1', answers: [['alpha']] });
  });

  test('a primary switch needs an allowed transition and an acknowledged revision-bound approval decision', async () => {
    const docker = new ExerciseDocker({ driver: { submit: () => ({ ok: true, submitted: true, acknowledged: true }) } });
    const run = exerciseRun();
    expect((await turnCommand({ run: run.runDir, operation: run.op('switch-primary', { to: 'swarm-orchestrator' }) }, run.env, {}, { docker })).status.reason).toBe('approval_not_observed');
    expect((await turnCommand({ run: run.runDir, operation: run.op('switch-primary', { to: 'hive-master' }) }, run.env, {}, { docker })).status.reason).toBe('transition_not_allowed');
    expect(submits(docker)).toEqual([]);
    await turnCommand({ run: run.runDir, operation: run.op('approve-plan', { project: PROJECT_ROOT, feature: 'f', revision: 'r1', contentHash: 'h1', permittedWork: 'edit README' }) }, run.env, {}, { docker });
    const approval = submits(docker)[0].input.op;
    expect(approval).toMatchObject({ kind: 'prompt', agent: 'architect-planner', plan: { feature: 'f', revision: 'r1', contentHash: 'h1' } });
    expect(approval.text).toContain("expectedRevision 'r1'");
    await turnCommand({ run: run.runDir, operation: run.op('switch-primary', { to: 'swarm-orchestrator' }) }, run.env, {}, { docker });
    // The switch names the supervisor's decision exactly: its operation, the user message that carried it, the feature, revision and content.
    expect(submits(docker)[1].input.op).toEqual({
      kind: 'switch', sessionId: 'ses_primary', agent: 'swarm-orchestrator', from: 'architect-planner',
      requireApproval: { feature: 'f', revision: 'r1', contentHash: 'h1', operationId: 'op-3', messageId: approval.messageId },
    });
    expect(runState(run.journal).primary).toBe('swarm-orchestrator');
    await turnCommand({ run: run.runDir, operation: run.op('prompt', { text: 'execute' }) }, run.env, {}, { docker });
    expect(submits(docker)[2].input.op.agent).toBe('swarm-orchestrator');
  });

  test('on v1 a checked switch is the controller record: acknowledged locally, then carried by every later prompt', async () => {
    const docker = new ExerciseDocker({ driver: { submit: (input: any) => (input.op.kind === 'switch' ? { ok: true, submitted: false, local: true } : { ok: true, submitted: true, acknowledged: true }) } });
    const run = exerciseRun();
    await turnCommand({ run: run.runDir, operation: run.op('approve-plan', { project: PROJECT_ROOT, feature: 'f', revision: 'r1', contentHash: 'h1', permittedWork: 'edit README' }) }, run.env, {}, { docker });
    const switched = await turnCommand({ run: run.runDir, operation: run.op('switch-primary', { to: 'swarm-orchestrator' }) }, run.env, {}, { docker });
    expect(switched).toMatchObject({ exit: EXIT.ok, status: { state: 'acknowledged', local: true } });
    expect(runState(run.journal).primary).toBe('swarm-orchestrator');
  });

  test('stop needs no credential or driver and confirms exact absence; an unsettled create is cleanup_unknown', async () => {
    const docker = new ExerciseDocker();
    const run = exerciseRun();
    require('node:fs').unlinkSync(run.auth);
    const stopped = await stopCommand({ run: run.runDir }, {}, { docker });
    expect(stopped).toMatchObject({ exit: EXIT.ok, status: { status: 'cleanup_confirmed', retained: [] } });
    expect(docker.calls.some((c) => c.args[0] === 'exec')).toBe(false);
    const pending = exerciseRun({ ledger: JSON.stringify({ event: 'create_requested', kind: 'container', nonce: 'lost-nonce' }) + '\n' });
    const unknown = await stopCommand({ run: pending.runDir }, {}, { docker: new ExerciseDocker() });
    expect(unknown.status.status).toBe('cleanup_unknown');
    expect(readFileSync(join(pending.runDir, 'resources.jsonl'), 'utf8')).not.toContain('create_absent');
  });
});

const HAS_FLOCK = (() => { const r = spawnSync('flock', ['--version'], { encoding: 'utf8' }); return r.status === 0 && /util-linux/.test(r.stdout); })();

describe('a prepared run settles the qualification runs it owns', () => {
  /** A qualification run registered by production code inside `run`; `create` also gives its ledger one container on `docker`. */
  async function qualificationRun(run: ReturnType<typeof exerciseRun>, docker: FakeDocker, { name = 'qualification', create = true } = {}) {
    const runId = `run-1-${name}`;
    const sub = registerSubrun(run.journal, run.runDir, name, { runId, engineId: ENGINE });
    const journal = new Journal(join(sub, 'records'));
    journal.write('input', { snapshotSha256: 'x', lockInode: String(statSync(join(sub, 'lock')).ino) });
    journal.write('prepared', { schema: 'ic-exercise-prepared/v1', status: 'prepared', runId, host: 'v1', request: validateRequest(EXERCISE_REQUEST), docker: { endpoint: 'unix:///fake.sock', engineId: ENGINE }, runtime: { imageId: 'sha256:image' }, qualificationRun: true });
    const resources = new Resources(docker as any, join(sub, 'resources.jsonl'), runId, ENGINE, { strictCreates: true });
    const containerId = create ? await resources.create('container', (labels: string[]) => ['create', ...labels, '--network', 'none', 'img', '120']) : null;
    return { sub, runId, containerId, journal };
  }
  const rmCalls = (docker: FakeDocker) => docker.calls.filter((c) => c.args[0] === 'rm').length;

  test.skipIf(!HAS_FLOCK)('a failed child removal stays retained until the container is actually removed, with no credential and inside the stop budget', async () => {
    const docker = new ExerciseDocker({ sticky: true });
    const run = exerciseRun({ ledger: '' });
    require('node:fs').unlinkSync(run.auth);
    const child = await qualificationRun(run, docker);
    // The qualification run's own stop, as its finish step runs it, cannot confirm the removal.
    expect((await stopCommand({ run: child.sub }, {}, { docker })).status).toMatchObject({ status: 'cleanup_present', retained: [{ id: child.containerId, state: 'present' }] });
    const before = docker.calls.length;
    // Before the owned ledgers were settled, this stop reported cleanup_confirmed with the container still present.
    const present = await stopCommand({ run: run.runDir }, {}, { docker });
    expect(present).toMatchObject({ exit: EXIT.failed, status: { status: 'cleanup_present', retained: [{ id: child.containerId, subrun: 'qualification', state: 'present' }] } });
    docker.behavior.sticky = false;
    const settled = await stopCommand({ run: run.runDir }, {}, { docker });
    expect(settled).toMatchObject({ exit: EXIT.ok, status: { status: 'cleanup_confirmed', retained: [] } });
    expect(docker.removed.has(child.containerId!)).toBe(true);
    expect(outstandingFromLedger(readFileSync(join(child.sub, 'resources.jsonl'), 'utf8'))).toEqual({ ids: new Map(), nonces: new Map() });
    // Settled ledgers need no further Docker work, and stop never touches a credential or the container's guard or driver.
    const removals = rmCalls(docker);
    expect((await stopCommand({ run: run.runDir }, {}, { docker })).status.status).toBe('cleanup_confirmed');
    expect(rmCalls(docker)).toBe(removals);
    const stopCalls = docker.calls.slice(before);
    expect(stopCalls.some((c) => c.args[0] === 'exec')).toBe(false);
    expect(Math.max(...stopCalls.map((c) => c.timeoutMs ?? 0))).toBeLessThanOrEqual(120_000);
    expect(readFileSync(join(run.runDir, 'records', 'stop.0001.json'), 'utf8')).toContain('"subrun": "qualification"');
  });

  test.skipIf(!HAS_FLOCK)('missing, unreadable, replaced or unregistered ownership is never read as absent, and nothing unproven is removed', async () => {
    const fs = require('node:fs');
    const cases: [string, (c: { run: any; child: any }) => void][] = [
      ['malformed ledger', ({ child }) => writeFileSync(join(child.sub, 'resources.jsonl'), 'not json\n')],
      ['missing ledger', ({ child }) => fs.unlinkSync(join(child.sub, 'resources.jsonl'))],
      ['ledger replaced by another file', ({ child }) => { const copy = join(child.sub, 'copy'); writeFileSync(copy, readFileSync(join(child.sub, 'resources.jsonl'))); renameSync(copy, join(child.sub, 'resources.jsonl')); }],
      ['ledger replaced by a link', ({ child }) => { const other = join(scratch(), 'other.jsonl'); writeFileSync(other, ''); fs.unlinkSync(join(child.sub, 'resources.jsonl')); symlinkSync(other, join(child.sub, 'resources.jsonl')); }],
      // The new file exists before the old one goes, so the two cannot share an inode number.
      ['lock replaced', ({ child }) => { const copy = join(child.sub, 'copy'); writeFileSync(copy, ''); renameSync(copy, join(child.sub, 'lock')); }],
      ['missing directory', ({ child }) => rmSync(child.sub, { recursive: true })],
      ['directory replaced by a link', ({ child }) => { rmSync(child.sub, { recursive: true }); symlinkSync(scratch(), child.sub); }],
      ['unreadable registration', ({ run }) => writeFileSync(join(run.runDir, 'records', 'subrun.qualification.json'), '{bad')],
      ['registration for another engine', ({ run }) => { const path = join(run.runDir, 'records', 'subrun.qualification.json'); writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), engineId: 'another-engine' })); }],
      ['registration of another name', ({ run }) => { const path = join(run.runDir, 'records', 'subrun.qualification.json'); writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), name: 'qualification-interrupt' })); }],
      ['no registration', ({ run }) => fs.unlinkSync(join(run.runDir, 'records', 'subrun.qualification.json'))],
    ];
    for (const [label, mutate] of cases) {
      const docker = new ExerciseDocker();
      const run = exerciseRun({ ledger: '' });
      const child = await qualificationRun(run, docker);
      mutate({ run, child });
      const before = docker.calls.length;
      const stopped = await stopCommand({ run: run.runDir }, {}, { docker });
      expect([label, stopped]).toEqual([label, { exit: EXIT.failed, status: { command: 'stop', status: 'cleanup_unknown', retained: [{ subrun: 'qualification', state: 'unknown' }], retainedImages: ['sha256:image'] } }]);
      expect([label, docker.removed.size]).toEqual([label, 0]);
      expect([label, docker.calls.slice(before).some((c) => c.args[0] === 'rm')]).toEqual([label, false]);
    }
    // A create whose response was lost keeps its nonce in the owned ledger, however often stop is retried.
    const docker = new ExerciseDocker();
    const run = exerciseRun({ ledger: '' });
    const child = await qualificationRun(run, docker, { create: false });
    fs.appendFileSync(join(child.sub, 'resources.jsonl'), JSON.stringify({ event: 'create_requested', kind: 'container', nonce: 'lost-nonce' }) + '\n');
    for (let i = 0; i < 2; i++) {
      expect(await stopCommand({ run: run.runDir }, {}, { docker })).toMatchObject({ exit: EXIT.failed, status: { status: 'cleanup_unknown', retained: [{ nonce: 'lost-nonce', subrun: 'qualification', state: 'unknown' }] } });
    }
    expect(outstandingFromLedger(readFileSync(join(child.sub, 'resources.jsonl'), 'utf8')).nonces.get('lost-nonce')).toBe('container');
    expect(readFileSync(join(child.sub, 'resources.jsonl'), 'utf8')).not.toContain('create_absent');
    // Neither registered run present and no directory: nothing was ever started, so there is nothing to settle.
    expect((await stopCommand({ run: exerciseRun({ ledger: '' }).runDir }, {}, { docker: new ExerciseDocker() })).status.status).toBe('cleanup_confirmed');
    // A qualification run owns no run of its own, so its stop never looks inside it for another.
    const sticky = new ExerciseDocker();
    const parent = exerciseRun({ ledger: '' });
    const inner = await qualificationRun(parent, sticky);
    mkdirSync(join(inner.sub, 'qualification'));
    expect((await stopCommand({ run: inner.sub }, {}, { docker: sticky })).status).toMatchObject({ status: 'cleanup_confirmed', retained: [] });
    expect(sticky.removed.has(inner.containerId!)).toBe(true);
  });

  test.skipIf(!HAS_FLOCK)('a qualification run another process still holds is unknown, and is settled once that process has ended', async () => {
    const docker = new ExerciseDocker();
    const run = exerciseRun({ ledger: '' });
    const child = await qualificationRun(run, docker);
    const held = await acquireRunLock(join(child.sub, 'lock'), { waitSeconds: 1 });
    expect(held.busy).toBe(false);
    const busy = await stopCommand({ run: run.runDir }, {}, { docker, subrunLockWaitSeconds: 1 });
    expect(busy).toMatchObject({ exit: EXIT.failed, status: { status: 'cleanup_unknown', retained: [{ subrun: 'qualification', state: 'unknown' }] } });
    expect(docker.removed.size).toBe(0);
    (held as any).release();
    expect(await stopCommand({ run: run.runDir }, {}, { docker })).toMatchObject({ exit: EXIT.ok, status: { status: 'cleanup_confirmed', retained: [] } });
    expect(docker.removed.has(child.containerId!)).toBe(true);
  });

  test('ownership is recorded with the ledger and lock identities before any resource, for the fixed qualification runs only', () => {
    expect(QUALIFICATION_SUBRUNS).toEqual(['qualification', 'qualification-interrupt']);
    const run = exerciseRun({ ledger: '' });
    const sub = registerSubrun(run.journal, run.runDir, 'qualification-interrupt', { runId: 'run-1-qi', engineId: ENGINE });
    expect(readFileSync(join(sub, 'resources.jsonl'), 'utf8')).toBe('');
    expect(run.journal.read('subrun.qualification-interrupt')!.value).toEqual({
      schema: 'ic-exercise-subrun/v1', name: 'qualification-interrupt', runId: 'run-1-qi', engineId: ENGINE,
      ledgerIno: String(statSync(join(sub, 'resources.jsonl')).ino), lockIno: String(statSync(join(sub, 'lock')).ino),
    });
    const code = (fn: () => unknown) => { try { fn(); return 'accepted'; } catch (e) { return (e as any).code; } };
    expect(code(() => registerSubrun(run.journal, run.runDir, '../escape', { runId: 'x', engineId: ENGINE }))).toBe('subrun_unknown');
    expect(code(() => registerSubrun(run.journal, run.runDir, 'qualification-interrupt', { runId: 'x', engineId: ENGINE }))).toBe('EEXIST');
    // Prepare registers each qualification run before the run can create anything.
    const source = readFileSync(join(import.meta.dir, 'exercise.mjs'), 'utf8');
    const subRun = source.slice(source.indexOf('async function subRun('), source.indexOf('export function descriptorsOf'));
    expect(subRun.indexOf('registerSubrun(base.journal')).toBeGreaterThan(-1);
    expect(subRun.indexOf('registerSubrun(base.journal')).toBeLessThan(subRun.indexOf('acquireRunLock('));
  });
});

describe('an interrupted prepare is settled by stop from the cleanup binding it persisted first', () => {
  const lockProbe = (lockPath: string) => spawnSync('flock', ['--nonblock', '--conflict-exit-code', '75', lockPath, 'true']).status;
  const guarded = new Proxy({}, { get: (_, key) => { throw new Error(`stop consulted env ${String(key)}`); } });
  const create = (resources: Resources) => resources.create('container', (labels: string[]) => ['create', ...labels, '--network', 'none', 'img', '120']);

  /**
   * What a prepare that ended before its final record leaves, written by the production writers in prepare's order: the
   * cleanup binding, a retained image, a container in the run's own ledger, and a registered qualification run with a
   * container of its own. There is no prepared record.
   */
  async function interruptedPrepare(docker: FakeDocker) {
    const runDir = scratch();
    mkdirSync(join(runDir, 'docker-config'));
    writeFileSync(join(runDir, 'lock'), '');
    writeFileSync(join(runDir, 'resources.jsonl'), '');
    const journal = Journal.create(join(runDir, 'records'));
    bindCleanup(journal, runDir, { runId: 'run-1', endpoint: 'unix:///fake.sock', engineId: ENGINE });
    const resources = new Resources(docker as any, join(runDir, 'resources.jsonl'), 'run-1', ENGINE, { strictCreates: true });
    resources.record({ event: 'image_retained', kind: 'image', id: 'sha256:image' });
    const parentId = await create(resources);
    const sub = registerSubrun(journal, runDir, 'qualification', { runId: 'run-1-q', engineId: ENGINE });
    const childId = await create(new Resources(docker as any, join(sub, 'resources.jsonl'), 'run-1-q', ENGINE, { strictCreates: true }));
    return { runDir, journal, sub, parentId, childId };
  }
  const refused = async (promise: Promise<unknown>) => { try { await promise; return 'accepted'; } catch (e) { return (e as HarnessError).code; } };

  test.skipIf(!HAS_FLOCK)('stop removes the run\'s own and its registered qualification run\'s resources by exact ID with no credential, no container exec and inside the stop budget', async () => {
    const docker = new ExerciseDocker();
    const prefix = await interruptedPrepare(docker);
    expect(prefix.journal.names()).toEqual(['cleanup-binding', 'subrun.qualification']);
    expect(prefix.journal.read('cleanup-binding')!.value).toEqual({
      schema: 'ic-exercise-cleanup-binding/v1', runId: 'run-1', endpoint: 'unix:///fake.sock', engineId: ENGINE,
      ledgerIno: String(statSync(join(prefix.runDir, 'resources.jsonl')).ino), lockInode: String(statSync(join(prefix.runDir, 'lock')).ino),
    });
    const before = docker.calls.length;
    const stopped = await stopCommand({ run: prefix.runDir }, guarded, { docker });
    expect(stopped).toEqual({ exit: EXIT.ok, status: { command: 'stop', status: 'cleanup_confirmed', retained: [], retainedImages: ['sha256:image'] } });
    expect([docker.removed.has(prefix.parentId), docker.removed.has(prefix.childId)]).toEqual([true, true]);
    const calls = docker.calls.slice(before);
    expect(calls.some((c) => c.args[0] === 'exec')).toBe(false);
    expect(Math.max(...calls.map((c) => c.timeoutMs ?? 0))).toBeLessThanOrEqual(120_000);
    expect(prefix.journal.read('stop.0001')!.value).toMatchObject({ state: 'cleanup_confirmed' });
    expect(prefix.journal.read('prepared')).toBeNull();
    // Settled ledgers need no further Docker work.
    const removals = docker.calls.filter((c) => c.args[0] === 'rm').length;
    expect((await stopCommand({ run: prefix.runDir }, guarded, { docker })).status.status).toBe('cleanup_confirmed');
    expect(docker.calls.filter((c) => c.args[0] === 'rm').length).toBe(removals);
  });

  test.skipIf(!HAS_FLOCK)('a create whose response was lost in the run or in a qualification run stays unknown however often stop is retried, while what was found is removed', async () => {
    const docker = new ExerciseDocker();
    const prefix = await interruptedPrepare(docker);
    require('node:fs').appendFileSync(join(prefix.runDir, 'resources.jsonl'), JSON.stringify({ event: 'create_requested', kind: 'container', nonce: 'parent-nonce' }) + '\n');
    require('node:fs').appendFileSync(join(prefix.sub, 'resources.jsonl'), JSON.stringify({ event: 'create_requested', kind: 'network', nonce: 'child-nonce' }) + '\n');
    for (let i = 0; i < 2; i++) {
      const stopped = await stopCommand({ run: prefix.runDir }, guarded, { docker });
      expect(stopped).toMatchObject({ exit: EXIT.failed, status: { status: 'cleanup_unknown', retained: [{ nonce: 'parent-nonce', state: 'unknown' }, { nonce: 'child-nonce', subrun: 'qualification', state: 'unknown' }] } });
    }
    expect([docker.removed.has(prefix.parentId), docker.removed.has(prefix.childId)]).toEqual([true, true]);
    for (const ledger of [join(prefix.runDir, 'resources.jsonl'), join(prefix.sub, 'resources.jsonl')]) expect(readFileSync(ledger, 'utf8')).not.toContain('create_absent');
  });

  test.skipIf(!HAS_FLOCK)('missing, malformed, inconsistent or replaced ownership removes nothing: no engine, endpoint or ID is ever guessed', async () => {
    const fs = require('node:fs');
    const bindingPath = (p: any) => join(p.runDir, 'records', 'cleanup-binding.json');
    const rewrite = (p: any, change: (b: any) => void) => { const b = JSON.parse(readFileSync(bindingPath(p), 'utf8')); change(b); writeFileSync(bindingPath(p), JSON.stringify(b)); };
    const cases: [string, string, (p: any) => void][] = [
      ['no binding and no prepared record', 'run_not_prepared', (p) => fs.unlinkSync(bindingPath(p))],
      ['unreadable binding', 'cleanup_binding_invalid', (p) => writeFileSync(bindingPath(p), '{bad')],
      ['binding of another schema', 'cleanup_binding_invalid', (p) => rewrite(p, (b) => { b.schema = 'other/v1'; })],
      ['binding without a run', 'cleanup_binding_invalid', (p) => rewrite(p, (b) => { b.runId = ''; })],
      ['binding for a remote endpoint', 'cleanup_binding_invalid', (p) => rewrite(p, (b) => { b.endpoint = 'tcp://10.0.0.1:2375'; })],
      ['binding without an engine', 'cleanup_binding_invalid', (p) => rewrite(p, (b) => { delete b.engineId; })],
      ['binding with a non-numeric ledger identity', 'cleanup_binding_invalid', (p) => rewrite(p, (b) => { b.ledgerIno = 'x'; })],
      ['prepared record for another engine', 'cleanup_binding_mismatch', (p) => p.journal.write('prepared', { schema: 'ic-exercise-prepared/v1', status: 'failed', runId: 'run-1', docker: { endpoint: 'unix:///fake.sock', engineId: 'another-engine' } })],
      ['prepared record for another run', 'cleanup_binding_mismatch', (p) => p.journal.write('prepared', { schema: 'ic-exercise-prepared/v1', status: 'failed', runId: 'run-2', docker: { endpoint: 'unix:///fake.sock', engineId: ENGINE } })],
      ['ledger replaced by another file', 'cleanup_ledger_replaced', (p) => { const copy = join(p.runDir, 'copy'); writeFileSync(copy, readFileSync(join(p.runDir, 'resources.jsonl'))); renameSync(copy, join(p.runDir, 'resources.jsonl')); }],
      ['ledger replaced by a link', 'cleanup_ledger_replaced', (p) => { const other = join(scratch(), 'other.jsonl'); writeFileSync(other, ''); fs.unlinkSync(join(p.runDir, 'resources.jsonl')); symlinkSync(other, join(p.runDir, 'resources.jsonl')); }],
      ['ledger missing', 'cleanup_ledger_replaced', (p) => fs.unlinkSync(join(p.runDir, 'resources.jsonl'))],
      ['lock replaced', 'lock_file_replaced', (p) => { const copy = join(p.runDir, 'copy'); writeFileSync(copy, ''); renameSync(copy, join(p.runDir, 'lock')); }],
    ];
    for (const [label, expected, mutate] of cases) {
      const docker = new ExerciseDocker();
      const prefix = await interruptedPrepare(docker);
      const before = docker.calls.length;
      mutate(prefix);
      expect([label, await refused(stopCommand({ run: prefix.runDir }, guarded, { docker }))]).toEqual([label, expected]);
      expect([label, docker.removed.size, docker.calls.slice(before).some((c) => c.args[0] === 'rm' || c.args[0] === 'kill')]).toEqual([label, 0, false]);
    }
    // Absence is confirmed only by the engine the binding names: a daemon that answers as another engine confirms nothing.
    const other = new ExerciseDocker({ otherEngine: true });
    const prefix = await interruptedPrepare(new ExerciseDocker());
    const stopped = await stopCommand({ run: prefix.runDir }, guarded, { docker: other });
    expect(stopped).toMatchObject({ exit: EXIT.failed, status: { status: 'cleanup_unknown', retained: [{ id: prefix.parentId, state: 'unknown' }, { id: prefix.childId, subrun: 'qualification', state: 'unknown' }] } });
  });

  test.skipIf(!HAS_FLOCK)('the recorded ownership authorizes cleanup only: start, turn and inspect refuse the run before reading a credential or reaching Docker', async () => {
    const docker = new ExerciseDocker();
    const prefix = await interruptedPrepare(docker);
    const before = docker.calls.length;
    const file = join(prefix.runDir, 'input.json');
    writeFileSync(file, '{}');
    expect(await refused(startCommand({ run: prefix.runDir, authorization: file, budgetSeconds: 120 }, guarded, {}, { docker }))).toBe('run_not_prepared');
    expect(await refused(turnCommand({ run: prefix.runDir, operation: file }, guarded, {}, { docker }))).toBe('run_not_prepared');
    expect(await refused(inspectCommand({ run: prefix.runDir }, guarded, { docker }))).toBe('run_not_prepared');
    expect(docker.calls.length).toBe(before);
    expect(prefix.journal.names()).toEqual(['cleanup-binding', 'subrun.qualification']);
  });

  test.skipIf(!HAS_FLOCK)('a prepare that holds the run lock keeps stop busy and removes nothing; once its process has ended stop settles what it left', async () => {
    const docker = new ExerciseDocker();
    const prefix = await interruptedPrepare(docker);
    const lockPath = join(prefix.runDir, 'lock');
    const holder = await acquireRunLock(lockPath, { waitSeconds: 1 });
    expect(holder.busy).toBe(false);
    let out = '';
    expect(await exerciseMain(['stop', '--run', prefix.runDir], { env: {}, stdout: { write: (s: string) => { out += s; return true; } }, lockWaitSeconds: 1 })).toBe(EXIT.busy);
    expect(JSON.parse(out)).toMatchObject({ status: 'busy', reason: 'lock_busy' });
    expect(docker.removed.size).toBe(0);
    (holder as any).release();
    const successor = await acquireRunLock(lockPath, { waitSeconds: 1 });
    expect(successor.busy).toBe(false);
    expect(await stopCommand({ run: prefix.runDir }, guarded, { docker, lock: successor as any })).toMatchObject({ exit: EXIT.ok, status: { status: 'cleanup_confirmed' } });
    (successor as any).release();
    expect([docker.removed.has(prefix.parentId), docker.removed.has(prefix.childId)]).toEqual([true, true]);
  });

  /** A Docker client that answers as a trusted local engine, and records whether the run lock was held at each call. */
  class BoundaryDocker extends ExerciseDocker {
    held: (number | null)[] = [];
    constructor(public endpoint: string, public lockPath: string) { super(); }
    async run(args: string[], options: any = {}) {
      this.held.push(lockProbe(this.lockPath));
      if (args[0] === 'version') return this.ok(JSON.stringify({ Client: { Version: '27.0.0' } }));
      if (args[0] === 'info' && args[2] === '{{json .}}') {
        return this.ok(JSON.stringify({ ID: ENGINE, OSType: 'linux', KernelVersion: release(), MemoryLimit: true, SwapLimit: true, CgroupVersion: '2', Name: 'local', OperatingSystem: 'Linux', ServerVersion: '27.0.0' }));
      }
      return super.run(args, options);
    }
  }

  test.skipIf(!HAS_FLOCK)('prepare holds its run lock for as long as it is active, binds cleanup as soon as the engine is verified, and leaves a run stop can settle', async () => {
    const root = scratch();
    const socket = join(root, 'docker.sock');
    const server = createServer();
    await new Promise<void>((resolveListen) => server.listen(socket, resolveListen));
    try {
      const runId = 'prepare-lock';
      const lockPath = join(root, runId, 'lock');
      const docker = new BoundaryDocker(`unix://${socket}`, lockPath);
      const prepared = await prepareCommand({ 'output-root': root, 'run-id': runId, host: 'v1', input: join(inputTree(), 'request.json'), 'candidate-ref': 'a'.repeat(40), endpoint: `unix://${socket}` }, {}, { docker });
      // The candidate does not exist, so prepare ends before it builds anything; every Docker call it made ran under its lock.
      expect(prepared.status).toMatchObject({ status: 'failed', failures: ['git_failed'] });
      expect(docker.held.length).toBeGreaterThan(0);
      expect(docker.held.every((h) => h === 75)).toBe(true);
      expect(lockProbe(lockPath)).toBe(0);
      const journal = new Journal(join(root, runId, 'records'));
      expect(journal.read('cleanup-binding')!.value).toEqual({
        schema: 'ic-exercise-cleanup-binding/v1', runId, endpoint: `unix://${socket}`, engineId: ENGINE,
        ledgerIno: String(statSync(join(root, runId, 'resources.jsonl')).ino), lockInode: String(statSync(lockPath).ino),
      });
      expect(await stopCommand({ run: join(root, runId) }, guarded, { docker })).toMatchObject({ exit: EXIT.ok, status: { status: 'cleanup_confirmed' } });
    } finally {
      server.close();
    }
    // Order in the source: the lock before any input is read, the engine verified before the binding, the binding before the first resource.
    const source = readFileSync(join(import.meta.dir, 'exercise.mjs'), 'utf8');
    const body = source.slice(source.indexOf('export async function prepareCommand('), source.indexOf('/** The catalog reply checked'));
    const order = ['acquireRunLock(', 'snapshotInputs(', 'verifyDockerBoundary(', 'bindCleanup(', 'resources.engineId =', 'await build(docker'].map((needle) => body.indexOf(needle));
    expect(order.every((at) => at > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  }, 30_000);

  test.skipIf(!HAS_FLOCK)('a prepare process holds the lock while it works and releases it only when it ends; a stop meanwhile is busy, and before the first resource there is nothing to settle', async () => {
    const root = scratch();
    const input = join(inputTree(), 'request.json');
    const scripts = scratch();
    const actor = join(scripts, 'prepare-actor.mjs');
    writeFileSync(actor, [
      `import { prepareCommand } from ${JSON.stringify(join(import.meta.dir, 'exercise.mjs'))};`,
      "const hung = { endpoint: 'unix:///nowhere.sock', run: () => new Promise(() => {}), json: () => { process.stdout.write('engaged\\n'); return new Promise(() => {}); } };",
      'setInterval(() => {}, 1000);',
      "await prepareCommand({ 'output-root': process.argv[2], 'run-id': 'killed-prepare', host: 'v1', input: process.argv[3], 'candidate-ref': 'a'.repeat(40), endpoint: 'unix:///nowhere.sock' }, {}, { docker: hung });",
    ].join('\n'));
    for (const runtime of ['node', process.execPath]) {
      const out = join(root, runtime === 'node' ? 'node' : 'bun');
      mkdirSync(out);
      const proc = spawn(runtime, [actor, out, input], { stdio: ['ignore', 'pipe', 'ignore'] });
      await new Promise<void>((resolveReady) => { let seen = ''; proc.stdout!.on('data', (d) => { seen += d; if (seen.includes('engaged')) resolveReady(); }); });
      const runDir = join(out, 'killed-prepare');
      expect([runtime, lockProbe(join(runDir, 'lock'))]).toEqual([runtime, 75]);
      let said = '';
      expect(await exerciseMain(['stop', '--run', runDir], { env: {}, stdout: { write: (s: string) => { said += s; return true; } }, lockWaitSeconds: 1 })).toBe(EXIT.busy);
      expect(JSON.parse(said)).toMatchObject({ status: 'busy', reason: 'lock_busy' });
      const exited = new Promise((r) => proc.on('exit', r));
      proc.kill('SIGKILL');
      await exited;
      expect(lockProbe(join(runDir, 'lock'))).toBe(0);
      // It ended before verifying an engine, so it created nothing and recorded no ownership.
      const docker = new ExerciseDocker();
      expect(await refused(stopCommand({ run: runDir }, guarded, { docker }))).toBe('run_not_prepared');
      expect(docker.calls).toEqual([]);
    }
  }, 60_000);
});

describe('supervised exercise serialization', () => {
  const FLOCK = spawnSync('flock', ['--version'], { encoding: 'utf8' });
  const hasFlock = FLOCK.status === 0 && /util-linux/.test(FLOCK.stdout);

  test.skipIf(!hasFlock)('a held lock makes start, turn, inspect and stop report busy; the holder is never displaced', async () => {
    const run = exerciseRun();
    const holder = spawn('flock', ['--exclusive', join(run.runDir, 'lock'), 'sleep', '30'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));
    for (const argv of [['inspect', '--run', run.runDir], ['stop', '--run', run.runDir], ['turn', '--run', run.runDir, '--operation', '/nowhere.json'],
      ['start', '--run', run.runDir, '--authorization', '/nowhere.json', '--budget-seconds', '120']]) {
      let out = '';
      const code = await exerciseMain(argv, { env: { ...process.env, ...run.env }, stdout: { write: (s: string) => { out += s; return true; } }, lockWaitSeconds: 1 });
      expect(code).toBe(EXIT.busy);
      expect(JSON.parse(out)).toMatchObject({ status: 'busy', reason: 'lock_busy' });
    }
    holder.kill('SIGKILL');
  }, 30_000);

  const lockProbe = (lockPath: string) => spawnSync('flock', ['--nonblock', '--conflict-exit-code', '75', lockPath, 'true']).status;
  // Children of `pid` whose command is `name`, read from /proc.
  const childrenNamed = (pid: number, name: string) => readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => {
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return Number(after[1]) === pid && stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')) === name;
    } catch { return false; }
  });

  test.skipIf(!hasFlock)('the acting process holds the lock through its own descriptor: the helper is gone, no child holds it, a busy attempt leaves nothing open', async () => {
    const run = exerciseRun();
    const lockPath = join(run.runDir, 'lock');
    const lockFile = statSync(lockPath);
    const owner = await acquireRunLock(lockPath, { waitSeconds: 2 });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      expect(owner).toMatchObject({ busy: false, ino: String(lockFile.ino) });
      // The flock helper has exited; the lock is held through this process's one descriptor of the file.
      expect(childrenNamed(process.pid, 'flock')).toEqual([]);
      expect(lockProbe(lockPath)).toBe(75);
      expect(descriptorsOf(process.pid, lockFile)).toBe(1);
      // A child started now, as every Docker client is, holds no descriptor of the lock file. Spawn reports the pid
      // before the child has finished starting, so look only after the child itself says it is running.
      const started = spawn('sh', ['-c', 'echo ready; exec sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] });
      child = started;
      await new Promise<void>((resolveReady, reject) => {
        let out = '';
        started.stdout!.on('data', (d) => { out += d; if (out.includes('ready\n')) resolveReady(); });
        started.once('error', reject);
        started.once('exit', (code, signal) => reject(new Error(`child exited before it was ready: ${code ?? signal}`)));
      });
      expect(descriptorsOf(started.pid!, lockFile)).toBe(0);
      // A second acquisition is busy, its helper is reaped and its descriptor closed before it returns.
      expect(await acquireRunLock(lockPath, { waitSeconds: 1 })).toEqual({ busy: true });
      expect(childrenNamed(process.pid, 'flock')).toEqual([]);
      expect(descriptorsOf(process.pid, lockFile)).toBe(1);
      owner.release();
      owner.release();
      expect(descriptorsOf(process.pid, lockFile)).toBe(0);
      expect(lockProbe(lockPath)).toBe(0);
    } finally {
      owner.release();
      child?.kill('SIGKILL');
    }
  }, 30_000);

  test.skipIf(!hasFlock)('the lock lasts exactly as long as the acting process, under Node and Bun: busy while it lives, free once it is killed though its child lives on', async () => {
    const scripts = scratch();
    const actor = join(scripts, 'actor.mjs');
    writeFileSync(actor, [
      "import { spawn } from 'node:child_process';",
      `import { acquireRunLock } from ${JSON.stringify(join(import.meta.dir, 'exercise.mjs'))};`,
      'const lock = await acquireRunLock(process.argv[2], { waitSeconds: 2 });',
      "const child = spawn('sleep', ['30'], { stdio: 'ignore' });",
      "process.stdout.write(JSON.stringify({ busy: lock.busy, child: child.pid }) + '\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    for (const runtime of ['node', process.execPath]) {
      const run = exerciseRun();
      const lockPath = join(run.runDir, 'lock');
      const lockFile = statSync(lockPath);
      const proc = spawn(runtime, [actor, lockPath], { stdio: ['ignore', 'pipe', 'ignore'] });
      const line = await new Promise<string>((resolveLine) => { let out = ''; proc.stdout!.on('data', (d) => { out += d; if (out.includes('\n')) resolveLine(out.split('\n')[0]); }); });
      const { busy, child } = JSON.parse(line);
      expect([runtime, busy]).toEqual([runtime, false]);
      expect(lockProbe(lockPath)).toBe(75);
      expect(descriptorsOf(proc.pid!, lockFile)).toBe(1);
      expect(descriptorsOf(child, lockFile)).toBe(0);
      // While the actor lives, a successor command is refused as busy.
      let out = '';
      expect(await exerciseMain(['inspect', '--run', run.runDir], { env: { ...process.env, ...run.env }, stdout: { write: (s: string) => { out += s; return true; } }, lockWaitSeconds: 1 })).toBe(EXIT.busy);
      expect(JSON.parse(out)).toMatchObject({ status: 'busy', reason: 'lock_busy' });
      const exited = new Promise((r) => proc.on('exit', r));
      proc.kill('SIGKILL');
      await exited;
      expect(() => process.kill(child, 0)).not.toThrow();
      expect(lockProbe(lockPath)).toBe(0);
      process.kill(child, 'SIGKILL');
    }
  }, 60_000);

  test.skipIf(!hasFlock)('a linked, hardlinked or replaced lock file is refused, and a lock on another inode never admits a command', async () => {
    const run = exerciseRun();
    const lockPath = join(run.runDir, 'lock');
    const code = async (p: Promise<unknown>) => { try { await p; return 'accepted'; } catch (e) { return (e as HarnessError).code; } };
    linkSync(lockPath, join(run.runDir, 'lock-copy'));
    expect(await code(acquireRunLock(lockPath, { waitSeconds: 1 }))).toBe('lock_file_replaced');
    rmSync(join(run.runDir, 'lock-copy'));
    const linked = join(run.runDir, 'linked-lock');
    symlinkSync(lockPath, linked);
    expect(await code(acquireRunLock(linked, { waitSeconds: 1 }))).toBe('lock_open_failed');
    expect(descriptorsOf(process.pid, statSync(lockPath))).toBe(0);
    // The path now names a new file: a lock taken on it is on a different inode from the one prepare recorded.
    renameSync(lockPath, join(run.runDir, 'lock-old'));
    writeFileSync(lockPath, '');
    const other = await acquireRunLock(lockPath, { waitSeconds: 1 });
    expect(other.busy).toBe(false);
    const docker = new ExerciseDocker();
    expect(await code(turnCommand({ run: run.runDir, operation: run.op('prompt', { text: 'x' }) }, run.env, {}, { docker, lock: other }))).toBe('lock_file_replaced');
    expect(await code(stopCommand({ run: run.runDir }, {}, { docker, lock: other }))).toBe('lock_file_replaced');
    expect(docker.calls).toEqual([]);
    (other as any).release();
  }, 30_000);
});


describe('supervised exercise publication, admission and deadlines', () => {
  const submits = (docker: ExerciseDocker) => docker.driverCalls.filter((c) => c.command === 'submit');
  const escapeAll = (text: string) => text.split('').map((ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const questionWire = (question: string, extra = '') => `{"ok":true,"quiescent":true,"reasons":[],"pending":[{"kind":"question","id":"que_1","sessionId":"ses_primary","toolCallId":null,"complete":true,"questionCount":1,"questions":[{"question":"${question}","questionChars":${JSON.parse(`"${question}"`).length},"header":null,"headerChars":null,"multiple":false,"options":["a"],"optionCount":1,"optionChars":[1],"optionDescriptions":["d"],"optionDescriptionChars":[1]}]}],"approvals":[],"tree":{"sessions":[],"complete":true,"failure":null},"busy":[]${extra}}`;

  /**
   * One reply or permission operation through the whole production path against native lists: the driver releases the
   * pending interactions, the host parses that release, and the driver submits against a native API that records every
   * request it is sent. `natives` maps a v1 list route to its body; `raw` is what the driver listed from them.
   */
  const attemptOn = (natives: Record<string, any>, raw: any[], host: 'v1' | 'v2' = 'v1') => async (action: string, fields: any) => {
    const sends: { path: string; body: any }[] = [];
    const table: Record<string, any> = {
      '/session/ses_primary': { id: 'ses_primary' }, '/session/ses_primary/children': [], '/session/ses_primary/message?limit=100': [], '/session/status': {}, ...natives,
    };
    const native = async (path: string, options: any = {}) => {
      if ((options.method ?? 'GET') !== 'GET') { sends.push({ path, body: options.body }); return { outcome: 'response' as const, status: 204, body: null, bytes: 0 }; }
      return path in table ? { outcome: 'response' as const, status: 200, body: table[path], bytes: 1 } : { outcome: 'response' as const, status: 404, body: null, bytes: 0 };
    };
    const docker: ExerciseDocker = new ExerciseDocker({ driver: {
      observe: () => ({ ...QUIET, quiescent: false, pending: releasedPending(raw, () => false) }),
      submit: (input: any) => driverSubmit({ ...input, trusted: false, expected: null }, { api: native as any, clock: () => docker.clockMs }),
    } });
    const run = exerciseRun({ host });
    const result = await turnCommand({ run: run.runDir, operation: run.op(action, fields) }, run.env, {}, { docker });
    return { result, sends, run };
  };

  test('a token that arrives as escape sequences is found after decoding, in kept and dropped fields alike, and is never published', async () => {
    const wire = questionWire(escapeAll(FAKE_ACCESS));
    expect(wire).not.toContain(FAKE_ACCESS);
    const scan = evidenceScanner({ access: FAKE_ACCESS, expires: 1 });
    expect(scan(wire)).toBe(false);
    expect(interpretReply(scan, 'observe', { stdout: wire + '\n', timedOut: false })).toMatchObject({ value: null, contaminated: true });
    const dropped = questionWire('fine', `,"note":"${escapeAll(FAKE_ACCESS)}"`);
    expect(interpretReply(scan, 'observe', { stdout: dropped + '\n', timedOut: false })).toMatchObject({ value: null, contaminated: true });
    expect(interpretReply(scan, 'observe', { stdout: questionWire('fine') + '\n', timedOut: false }).contaminated).toBe(false);
    expect(scanValue(scan, { nested: [{ 'k\u0073ynthetic-access-token-0123456789abcdef': 1 }] })).toBe(true);
    const docker = new ExerciseDocker({ driver: { observe: () => wire } });
    const run = exerciseRun();
    const result = await inspectCommand({ run: run.runDir, request: run.inspection({ conversation: {} }) }, run.env, { docker });
    expect(result.status).toMatchObject({ status: 'content_unavailable' });
    expect(JSON.stringify(result)).not.toContain(FAKE_ACCESS);
    expect(run.journal.read('latch')!.value.code).toBe('evidence_contaminated');
    expect(existsSync(join(run.runDir, 'evidence'))).toBe(false);
  });

  test('driver replies are rebuilt from allowlisted fields; unknown words, oversize text and wrong types reject the reply', () => {
    const quiet = { ok: true, quiescent: true, reasons: [], pending: [], approvals: [], tree: { sessions: [], complete: true, failure: null }, busy: [] };
    expect(parseDriverReply('observe', { ...quiet, extra: 'dropped' })).toEqual(quiet);
    expect(parseDriverReply('observe', { ...quiet, reasons: ['made_up_reason'] })).toBeNull();
    expect(parseDriverReply('observe', { ...quiet, reasons: ['session_busy:ses_abc', 'tree_changed'] })).not.toBeNull();
    expect(parseDriverReply('observe', { ...quiet, tree: { ...quiet.tree, failure: 'sk-abcdefghijklmnopqrstuvwxyz' } })).toBeNull();
    expect(parseDriverReply('observe', { ...quiet, pending: [{ kind: 'question', id: 'que_1', sessionId: 'not-a-session', toolCallId: null }] })).toBeNull();
    expect(parseDriverReply('observe', { ...quiet, pending: [{ kind: 'question', id: 'que_1', sessionId: 'ses_a', toolCallId: null, questions: [{ question: 'x'.repeat(2001), header: null, multiple: false, options: [] }] }] })).toBeNull();
    expect(parseDriverReply('observe', { ...quiet, list: [{ prefix: '.hive/features/', entries: [{ path: 'a', bytes: 1 }], complete: true, absent: false, rejected: false, omitted: { links: 0, special: 0, excluded: 1, names: 0 } }] })).not.toBeNull();
    expect(parseDriverReply('observe', { ...quiet, list: [{ prefix: 'x', entries: [{ path: 'a', bytes: '1' }], complete: true, absent: false, rejected: false, omitted: { links: 0, special: 0, excluded: 0, names: 0 } }] })).toBeNull();
    expect(parseDriverReply('submit', { ok: false, failure: 'native_auth_changed' })).toEqual({ ok: false, failure: 'native_auth_changed' });
    expect(parseDriverReply('submit', { ok: false, failure: 'ic_made_up_error' })).toBeNull();
    expect(parseDriverReply('submit', { ok: false, failure: 'sk-0123456789abcdefghijklmnop' })).toBeNull();
    expect(parseDriverReply('submit', { ok: true, submitted: true, acknowledged: 'yes' })).toBeNull();
    expect(parseDriverReply('submit', { ok: true, submitted: false, refused: 'who_knows' })).toBeNull();
    expect(parseDriverReply('submit', { ok: true, submitted: false, refused: 'plan_not_approved', reasons: [] })).not.toBeNull();
    expect(parseDriverReply('nonsense', { ok: true })).toBeNull();
    expect(failureWord('ic_made_up_error')).toBe('other');
    expect(failureWord('sk-0123456789abcdefghijklmnop')).toBe('other');
    expect(failureWord('not_quiescent')).toBe('not_quiescent');
    expect(failureWord('operation_contaminated')).toBe('operation_contaminated');
    expect(parseDriverReply('clock', { ok: true, clockMs: 12.5, processMs: 3 })).toEqual({ ok: true, clockMs: 12.5, processMs: 3 });
    expect(parseDriverReply('clock', { ok: true, clockMs: '12', processMs: 3 })).toBeNull();
  });

  test('the host vocabulary names every failure and refusal word the driver and plan reader can print', () => {
    const literals = new Set<string>();
    for (const file of ['exercise-driver.ts', 'plan-reader.ts']) {
      const text = readFileSync(join(import.meta.dir, file), 'utf8');
      for (const m of text.matchAll(/(?:fail\('|failure: '|refuse\(')([a-z_]+)'/g)) literals.add(m[1]);
    }
    expect(literals.size).toBeGreaterThan(20);
    for (const word of literals) expect([word, DRIVER_FAILURES.has(word) || DRIVER_REFUSALS.has(word)]).toEqual([word, true]);
  });

  test('a pending interaction states what was clipped or left out from the driver through the host, and a decision on an incomplete one is refused unsent', async () => {
    const resources = Array.from({ length: 17 }, (_, i) => (i === 2 ? 'r'.repeat(523) : `/work/proj/f${i}.txt`));
    const options = Array.from({ length: 33 }, (_, i) => ({ label: i === 5 ? 'o'.repeat(301) : `opt${i}` }));
    const small = '/work/proj/a.txt';
    const natives = {
      '/question': [
        { id: 'que_1', sessionID: 'ses_primary', tool: { callID: 'call_q' }, questions: [{ question: 'q'.repeat(2001), header: 'h', options }] },
        { id: 'que_2', sessionID: 'ses_primary', tool: { callID: 'call_s' }, questions: [{ question: 'Which?', header: 'H', options: [{ label: 'alpha' }, { label: 'beta' }] }] },
        { id: 'que_3', sessionID: 'ses_primary', tool: { callID: 'call_m' }, questions: Array.from({ length: 17 }, (_, i) => ({ question: `Q${i}?`, header: null, options: [{ label: 'a' }] })) },
      ],
      '/permission': [
        { id: 'per_1', sessionID: 'ses_primary', tool: { callID: 'call_p' }, permission: 'edit', patterns: resources },
        { id: 'per_2', sessionID: 'ses_primary', tool: { callID: 'call_t' }, permission: 'edit', patterns: [small] },
      ],
    };
    const tree = { sessions: [{ id: 'ses_primary', parentId: null, agent: null }], complete: true, failure: null };
    const raw = (await pendingInteractions('v1', tree, routeGet({ '/question': api(natives['/question']), '/permission': api(natives['/permission']) })))!;
    const [bigQuestion, smallQuestion, manyQuestions, bigPermission, smallPermission] = releasedPending(raw, () => false);

    // The driver states the original count and size of everything it clipped, and marks the item incomplete.
    expect(bigPermission).toMatchObject({ complete: false, permission: { resourceCount: 17 } });
    expect(bigPermission.permission.resources).toHaveLength(16);
    expect(bigPermission.permission.resources[2]).toHaveLength(500);
    expect(bigPermission.permission.resourceChars[2]).toBe(523);
    expect(bigQuestion).toMatchObject({ complete: false, questionCount: 1 });
    expect(bigQuestion.questions[0]).toMatchObject({ questionChars: 2001, headerChars: 1, optionCount: 33 });
    expect(bigQuestion.questions[0].question).toHaveLength(2000);
    expect(bigQuestion.questions[0].options).toHaveLength(32);
    expect(bigQuestion.questions[0].optionChars[5]).toBe(301);
    expect(bigQuestion.questions[0].options[5]).toHaveLength(300);
    expect(manyQuestions).toMatchObject({ complete: false, questionCount: 17 });
    expect(manyQuestions.questions).toHaveLength(16);
    expect(smallQuestion).toMatchObject({ complete: true, questionCount: 1, questions: [{ questionChars: 6, headerChars: 1, optionCount: 2, optionChars: [5, 4] }] });
    expect(smallPermission).toMatchObject({ complete: true, permission: { resourceCount: 1, resourceChars: [small.length] } });
    // A value that cannot be shown as text is never read as an empty one.
    expect(releasedPending([{ kind: 'permission', id: 'per_9', sessionId: 'ses_a', toolCallId: null, permission: { action: 'edit', resources: [{ not: 'text' }] } }], () => false)![0].complete).toBe(false);

    // The host keeps all of it, and rejects a reply whose claim of completeness the sizes contradict.
    const reply = { ok: true, quiescent: false, reasons: [], pending: releasedPending(raw, () => false), approvals: [], tree: { sessions: [], complete: true, failure: null }, busy: [] };
    const wire = () => JSON.parse(JSON.stringify(reply));
    const parsed = parseDriverReply('observe', wire());
    expect(parsed.pending).toEqual(reply.pending);
    const tampered = (mutate: (r: any) => void) => { const r = wire(); mutate(r); return parseDriverReply('observe', r); };
    expect(tampered((r) => { r.pending[3].complete = true; })).toBeNull();
    expect(tampered((r) => { r.pending[0].complete = true; })).toBeNull();
    expect(tampered((r) => { r.pending[2].complete = true; })).toBeNull();
    expect(tampered((r) => { delete r.pending[1].complete; })).toBeNull();
    expect(tampered((r) => { delete r.pending[1].questionCount; })).toBeNull();
    expect(tampered((r) => { r.pending[3].permission.resourceChars[2] = 10; })).toBeNull();
    expect(tampered((r) => { r.pending[3].permission.resourceChars.pop(); })).toBeNull();
    expect(tampered((r) => { r.pending[0].questions[0].optionChars.pop(); })).toBeNull();
    expect(tampered((r) => { r.pending[1].questions[0].optionCount = 1; })).toBeNull();
    expect(tampered((r) => { r.pending[1].complete = true; })).not.toBeNull();

    // Replies and approvals are decided on the released form: an incomplete one is refused before anything is sent.
    const attempt = attemptOn(natives, raw);
    const refused = await attempt('permission', { requestId: 'per_1', decision: 'once' });
    expect(refused.result.status).toMatchObject({ state: 'refused', reason: 'request_incomplete' });
    expect(refused.result.status.pending.find((p: any) => p.id === 'per_1')).toMatchObject({ complete: false, permission: { resourceCount: 17 } });
    expect(refused.sends).toEqual([]);
    expect(runState(refused.run.journal).unresolved).toEqual([]);
    const rejected = await attempt('permission', { requestId: 'per_1', decision: 'reject' });
    expect(rejected.result.status).toMatchObject({ state: 'acknowledged' });
    expect(rejected.sends).toEqual([{ path: '/permission/per_1/reply', body: { reply: 'reject' } }]);
    const approved = await attempt('permission', { requestId: 'per_2', decision: 'once' });
    expect(approved.result.status).toMatchObject({ state: 'acknowledged' });
    expect(approved.sends).toEqual([{ path: '/permission/per_2/reply', body: { reply: 'once' } }]);
    for (const [requestId, answers] of [['que_1', [['opt0']]], ['que_3', Array.from({ length: 16 }, () => ['a'])]] as const) {
      const blocked = await attempt('reply', { requestId, answers });
      expect(blocked.result.status).toMatchObject({ state: 'refused', reason: 'request_incomplete' });
      expect(blocked.sends).toEqual([]);
    }
    const answered = await attempt('reply', { requestId: 'que_2', answers: [['alpha']] });
    expect(answered.result.status).toMatchObject({ state: 'acknowledged' });
    expect(answered.sends).toEqual([{ path: '/question/que_2/reply', body: { answers: [['alpha']] } }]);
  });

  test('a choice keeps the description its host gave it from the native list through release, host parse and reply, on both hosts; one that is clipped or not text makes the question incomplete', async () => {
    const apply = { label: 'Apply', description: 'Apply the migration and keep every backup' };
    const wipe = { label: 'Delete all backups', description: 'Apply the migration, then permanently remove every backup' };
    const tree = { sessions: [{ id: 'ses_primary', parentId: null, agent: null }], complete: true, failure: null };
    const natives = (host: 'v1' | 'v2', options: any[]): Record<string, any> => host === 'v1'
      ? { '/question': [{ id: 'que_1', sessionID: 'ses_primary', tool: { callID: 'call_q' }, questions: [{ question: 'Which?', header: 'H', options }] }], '/permission': [] }
      : {
        '/api/session/ses_primary': { data: { id: 'ses_primary' } }, '/api/session?parentID=ses_primary&limit=100&order=asc': { data: [] }, '/api/session/ses_primary/message?limit=100&order=asc': { data: [] },
        '/api/session/active': { data: {} }, '/api/session/ses_primary/permission': { data: [] },
        '/api/session/ses_primary/form': { data: [{ id: 'frm_1', sessionID: 'ses_primary', metadata: { tool: { id: 'call_q' } }, fields: [{ key: 'q0', type: 'string', title: 'H', description: 'Which?', options: options.map((o) => ({ value: o.label, label: o.label, description: o.description })) }] }] },
      };
    const listed = async (host: 'v1' | 'v2', options: any[]) => (await pendingInteractions(host, tree, routeGet(Object.fromEntries(Object.entries(natives(host, options)).map(([path, body]) => [path, api(body)])))))!;
    const observe = (pending: any) => ({ ok: true, quiescent: false, reasons: [], pending, approvals: [], tree: { sessions: [], complete: true, failure: null }, busy: [] });

    for (const host of ['v1', 'v2'] as const) {
      // Apply / Delete all backups: the descriptions are what tells the two choices apart, so they are released with the labels.
      const raw = await listed(host, [apply, wipe]);
      const released = releasedPending(raw, () => false);
      expect([host, released[0].complete]).toEqual([host, true]);
      expect(released[0].questions[0]).toMatchObject({
        options: ['Apply', 'Delete all backups'], optionCount: 2, optionChars: [5, 18],
        optionDescriptions: [apply.description, wipe.description], optionDescriptionChars: [apply.description.length, wipe.description.length],
      });
      // The host keeps them, and rejects a release that drops them or states sizes the texts contradict.
      const wire = () => JSON.parse(JSON.stringify(observe(released)));
      expect(parseDriverReply('observe', wire())!.pending).toEqual(released);
      const tampered = (mutate: (q: any) => void) => { const r = wire(); mutate(r.pending[0].questions[0]); return parseDriverReply('observe', r); };
      expect(tampered((q) => { delete q.optionDescriptions; })).toBeNull();
      expect(tampered((q) => { delete q.optionDescriptionChars; })).toBeNull();
      expect(tampered((q) => { q.optionDescriptions.pop(); })).toBeNull();
      expect(tampered((q) => { q.optionDescriptionChars.pop(); })).toBeNull();
      expect(tampered((q) => { q.optionDescriptionChars[1] = 3; })).toBeNull();
      expect(tampered((q) => { q.optionDescriptions[1] = 'x'.repeat(501); q.optionDescriptionChars[1] = 501; })).toBeNull();
      expect(tampered((q) => { q.optionDescriptionChars[1] = 900; })).toBeNull();
      // The labels stay the native answer values: the reply is sent on the released form, and carries the label alone.
      const answered = await attemptOn(natives(host, [apply, wipe]), raw, host)('reply', { requestId: host === 'v1' ? 'que_1' : 'frm_1', answers: [['Apply']] });
      expect([host, answered.result.status]).toMatchObject([host, { state: 'acknowledged' }]);
      expect(answered.sends).toEqual([host === 'v1'
        ? { path: '/question/que_1/reply', body: { answers: [['Apply']] } }
        : { path: '/api/session/ses_primary/form/frm_1/reply', body: { answer: { q0: 'Apply' } } }]);
    }

    // A description beyond its bound is clipped with its original size stated and the question is incomplete: the host
    // does not accept a claim of completeness the sizes contradict, and a reply on it is refused before anything is sent.
    const long = 'Apply the migration, then permanently remove every backup. '.repeat(10);
    for (const host of ['v1', 'v2'] as const) {
      const options = [apply, { label: wipe.label, description: long }];
      const raw = await listed(host, options);
      const [question] = releasedPending(raw, () => false);
      expect([host, question.complete]).toEqual([host, false]);
      expect(question.questions[0].optionDescriptions[1]).toHaveLength(500);
      expect(question.questions[0].optionDescriptionChars).toEqual([apply.description.length, long.length]);
      expect([host, parseDriverReply('observe', JSON.parse(JSON.stringify(observe([{ ...question, complete: true }]))))]).toEqual([host, null]);
      expect(parseDriverReply('observe', JSON.parse(JSON.stringify(observe([question]))))!.pending).toEqual([question]);
      const refused = await attemptOn(natives(host, options), raw, host)('reply', { requestId: host === 'v1' ? 'que_1' : 'frm_1', answers: [['Apply']] });
      expect([host, refused.result.status]).toMatchObject([host, { state: 'refused', reason: 'request_incomplete' }]);
      expect(refused.sends).toEqual([]);
    }

    // A description that is not text is never read as an absent one; an absent one is released as empty.
    for (const bad of [{ not: 'text' }, 7, ['a']]) {
      expect(releasedPending(await listed('v1', [{ label: 'Apply', description: bad }]), () => false)[0].complete).toBe(false);
    }
    expect(releasedPending(await listed('v1', [{ label: 'Apply' }]), () => false)[0]).toMatchObject({ complete: true, questions: [{ options: ['Apply'], optionDescriptions: [''], optionDescriptionChars: [0] }] });
    // Descriptions pass the evidence scanner like every other released text.
    const scanned = await listed('v1', [apply, wipe]);
    expect(() => releasedPending(scanned, (t) => t.includes('permanently'))).toThrow();
  });

  test('a refusal that lists native questions is published only through the final continuity check', async () => {
    const pending = released({ kind: 'question', id: 'que_1', sessionId: 'ses_child', toolCallId: 'call_q', questions: [{ question: 'Which?', header: null, multiple: false, options: ['alpha'], optionDescriptions: ['first'] }] });
    const driver = { observe: () => ({ ...QUIET, pending }) };
    const docker = new ExerciseDocker({ driver });
    docker.compares = [true, false];
    const run = exerciseRun();
    const result = await turnCommand({ run: run.runDir, operation: run.op('reply', { requestId: 'que_9', answers: [['alpha']] }) }, run.env, {}, { docker });
    expect(result.status).toMatchObject({ status: 'content_unavailable', reason: 'host_auth_changed', latched: true });
    expect(JSON.stringify(result.status)).not.toContain('Which?');
    expect(run.journal.read('latch')!.value.code).toBe('host_auth_changed');
    const intact = exerciseRun();
    const listed = await turnCommand({ run: intact.runDir, operation: intact.op('reply', { requestId: 'que_9', answers: [['alpha']] }) }, intact.env, {}, { docker: new ExerciseDocker({ driver }) });
    expect(listed.status).toMatchObject({ state: 'refused', reason: 'request_not_pending', pending: [{ id: 'que_1' }] });
  });

  test('inspect publishes nothing when the credential changed between the observation and the release', async () => {
    const docker = new ExerciseDocker({ driver: { observe: () => ({ ...QUIET, pending: released({ kind: 'question', id: 'que_1', sessionId: 'ses_primary', toolCallId: null, questions: [{ question: 'Which?', header: null, multiple: false, options: ['a'], optionDescriptions: ['only'] }] }) }) } });
    docker.compares = [true, false];
    const run = exerciseRun();
    const result = await inspectCommand({ run: run.runDir, request: run.inspection({ conversation: {} }) }, run.env, { docker });
    expect(result.status).toMatchObject({ status: 'content_unavailable', reason: 'host_auth_changed' });
    expect(result.status).not.toHaveProperty('pending');
    expect(existsSync(join(run.runDir, 'evidence'))).toBe(false);
    expect(run.journal.read('latch')!.value.code).toBe('host_auth_changed');
  });

  test('inspect forwards a list request and publishes the scanned inventory with its completeness', async () => {
    const listing = (prefix: string) => ({ prefix, entries: [{ path: '.hive/features/01_f/plan.md', bytes: 12 }], complete: false, absent: false, rejected: false, omitted: { links: 1, special: 0, excluded: 2, names: 0 } });
    const docker = new ExerciseDocker({ driver: { observe: (input: any) => ({ ...QUIET, list: input.request.list.map(listing) }) } });
    const run = exerciseRun();
    const result = await inspectCommand({ run: run.runDir, request: run.inspection({ list: ['.hive/features/'] }) }, run.env, { docker });
    expect(docker.driverCalls.find((c) => c.command === 'observe')!.input.request.list).toEqual(['.hive/features/']);
    expect(result.exit).toBe(EXIT.ok);
    const evidence = JSON.parse(readFileSync(result.status.evidence, 'utf8'));
    expect(evidence.list).toEqual([listing('.hive/features/')]);
  });

  test('admission is decided with fresh guard time immediately before the effect; an interrupt alone is admitted in the final window', async () => {
    expect(admitsAction('prompt', NO_NEW_WORK_MS)).toBe(false);
    expect(admitsAction('prompt', NO_NEW_WORK_MS + 1)).toBe(true);
    expect(admitsAction('interrupt', NO_NEW_WORK_MS - 1)).toBe(true);
    expect(admitsAction('interrupt', INTERRUPT_FLOOR_MS)).toBe(false);
    expect(admitsAction('interrupt', INTERRUPT_FLOOR_MS + 1)).toBe(true);
    expect(admitsAction('interrupt', Number.NaN)).toBe(false);
    // The cutoff passes while the command works: the first check sees 70 s, the check just before the effect sees 59 s.
    const docker = new ExerciseDocker({ driver: { submit: () => ({ ok: true, submitted: true, acknowledged: true }) } });
    docker.remainingSeq = [70_000, 59_000];
    const run = exerciseRun();
    const late = await turnCommand({ run: run.runDir, operation: run.op('prompt', { text: 'x' }, 'p1') }, run.env, {}, { docker });
    expect(late.status).toMatchObject({ state: 'refused', reason: 'no_new_work_window' });
    expect(submits(docker)).toEqual([]);
    expect(run.journal.read('op.0001.outcome')!.value).toMatchObject({ state: 'refused', reason: 'no_new_work_window' });
    expect(runState(run.journal).unresolved).toEqual([]);
    // In the final window an interrupt is sent; everything else is refused.
    const finalWindow = new ExerciseDocker({ remainingMs: 30_000, driver: { submit: () => ({ ok: true, submitted: true, acknowledged: true, status: 200 }) } });
    const r2 = exerciseRun();
    const interrupted = await turnCommand({ run: r2.runDir, operation: r2.op('interrupt', {}, 'i1') }, r2.env, {}, { docker: finalWindow });
    expect(interrupted).toMatchObject({ exit: EXIT.ok, status: { state: 'acknowledged' } });
    expect(submits(finalWindow).length).toBe(1);
    const r3 = exerciseRun();
    expect((await turnCommand({ run: r3.runDir, operation: r3.op('prompt', { text: 'x' }, 'p1') }, r3.env, {}, { docker: finalWindow })).status.reason).toBe('no_new_work_window');
    // Too close to the hard stop even for an interrupt.
    const nearEnd = new ExerciseDocker({ remainingMs: 4_000, driver: { submit: () => ({ ok: true, submitted: true, acknowledged: true }) } });
    const r4 = exerciseRun();
    expect((await turnCommand({ run: r4.runDir, operation: r4.op('interrupt', {}, 'i1') }, r4.env, {}, { docker: nearEnd })).status.reason).toBe('no_new_work_window');
    expect(submits(nearEnd)).toEqual([]);
  });

  test('cutoffs are translated onto the guard clock conservatively: latency only makes them earlier, and the two clocks never share an origin', () => {
    // The container clock runs at an unknown offset from the host's; the guard reads its clock somewhere between the
    // host's readings before (h1) and after (h2) its reply.
    for (const offset of [7_777_777, -123_456]) {
      for (const latency of [0, 50, 2_000]) {
        for (const share of [0, 0.5, 1]) {
          const h1 = 10_000;
          const h2 = h1 + latency;
          const guardClockMs = h1 + latency * share + offset;
          const end = h1 + 60_000;
          const { commandEndClock, actionEndClock } = containerCutoffs({ guardClockMs, hostMs: h2, deadlineClockMs: guardClockMs + 900_000 }, end, NO_NEW_WORK_MS);
          const trueEnd = end + offset;
          expect(commandEndClock).toBeLessThanOrEqual(trueEnd - CLOCK_MARGIN_MS);
          expect(commandEndClock).toBeGreaterThanOrEqual(trueEnd - CLOCK_MARGIN_MS - latency);
          expect(actionEndClock).toBe(guardClockMs + 900_000 - NO_NEW_WORK_MS);
        }
      }
    }
    expect(containerCutoffs({ guardClockMs: 10, hostMs: 0, deadlineClockMs: 100 }, 50)).toEqual({ commandEndClock: 60 - CLOCK_MARGIN_MS });
    expect(actionReserveMs('interrupt')).toBe(INTERRUPT_FLOOR_MS);
    for (const action of ['prompt', 'reply', 'permission', 'approve-plan', 'switch-primary']) expect(actionReserveMs(action)).toBe(NO_NEW_WORK_MS);
    expect(sharedClockBracket(1, 2, 3)).toBe(true);
    expect(sharedClockBracket(1, 1, 1)).toBe(true);
    expect(sharedClockBracket(2, 1, 3)).toBe(false);
    expect(sharedClockBracket(1, 4, 3)).toBe(false);
    expect(sharedClockBracket(1, Number.NaN, 3)).toBe(false);
    expect(sharedClockBracket(undefined, 2, 3)).toBe(false);
  });

  test('the host hands the driver absolute guard-clock cutoffs from its own monotonic budget; a wall-clock change gives no time, and a spent budget sends nothing', async () => {
    const realNow = Date.now;
    const inputs: any[] = [];
    try {
      for (const shift of [-3_600_000, 3_600_000]) {
        Date.now = () => realNow() + shift;
        for (const action of ['prompt', 'interrupt']) {
          const docker = new ExerciseDocker({ driver: { submit: () => ({ ok: true, submitted: true, acknowledged: true }) } });
          const run = exerciseRun();
          const result = await turnCommand({ run: run.runDir, operation: run.op(action, action === 'prompt' ? { text: 'x' } : {}, 'a1') }, run.env, {}, { docker });
          expect(result.exit).toBe(EXIT.ok);
          const input = submits(docker)[0].input;
          inputs.push(input);
          expect(input).not.toHaveProperty('deadlineAt');
          expect(input).not.toHaveProperty('deadlineMs');
          // The turn's working budget is 60 s less the release reserve, so its end on the guard clock is well inside 60 s.
          expect(input.commandEndClock).toBeGreaterThan(docker.clockMs);
          expect(input.commandEndClock).toBeLessThanOrEqual(docker.clockMs + 60_000 - CLOCK_MARGIN_MS);
          expect(input.actionEndClock).toBe(docker.clockMs + 900_000 - actionReserveMs(action));
        }
        // A command whose host budget began 61 s ago, by the host's monotonic clock, does nothing at all.
        const docker = new ExerciseDocker({ driver: { submit: () => ({ ok: true, submitted: true, acknowledged: true }) } });
        const run = exerciseRun();
        const spent = await turnCommand({ run: run.runDir, operation: run.op('prompt', { text: 'x' }, 'late') }, run.env, {}, { docker, startedAt: performance.now() - 61_000 });
        expect(spent).toEqual({ exit: EXIT.failed, status: { command: 'turn', status: 'refused', reason: 'command_deadline_exceeded' } });
        expect(docker.calls).toEqual([]);
        expect(run.journal.read('latch')).toBeNull();
      }
    } finally {
      Date.now = realNow;
    }
    expect(inputs).toHaveLength(4);
  });

  test('the driver checks both cutoffs after its observation, at the request: an observation that outlives the effect cutoff sends nothing, whatever the wall clock says', async () => {
    const run = async (action: 'prompt' | 'interrupt', cutoffs: any, { step = 10, wall = 0 } = {}) => {
      const clock = { now: 1_000 };
      const sends: string[] = [];
      const table: Record<string, any> = { '/session/ses_a': { id: 'ses_a' }, '/session/ses_a/children': [], '/session/ses_a/message?limit=100': [], '/session/status': {}, '/question': [], '/permission': [] };
      const api = async (path: string, options: any) => {
        if ((options.method ?? 'GET') !== 'GET') { sends.push(path); return { outcome: 'response' as const, status: 204, body: null, bytes: 0 }; }
        clock.now += step;
        return path in table ? { outcome: 'response' as const, status: 200, body: table[path], bytes: 1 } : { outcome: 'response' as const, status: 404, body: null, bytes: 0 };
      };
      const op = action === 'prompt'
        ? { kind: 'prompt', sessionId: 'ses_a', messageId: 'msg_000000000001AAAAAAAAAAAAAA', agent: 'architect-planner', model: { ref: 'openai/gpt-test', variant: null }, text: 'hi', plan: null }
        : { kind: 'interrupt', sessionId: 'ses_a' };
      const realNow = Date.now;
      Date.now = () => realNow() + wall;
      try {
        const reply = await driverSubmit({ host: 'v1', trusted: false, expected: null, sessionId: 'ses_a', op, ...cutoffs }, { api: api as any, clock: () => clock.now });
        return { reply, sends, observedUntil: clock.now };
      } finally {
        Date.now = realNow;
      }
    };
    const wallAhead = Date.now() + 60_000;
    for (const wall of [0, -3_600_000, 3_600_000]) {
      for (const action of ['prompt', 'interrupt'] as const) {
        // The observation reads seven pages at 10 ms each: the effect cutoff at 1050 passes during it.
        const crossed = await run(action, { commandEndClock: 100_000, actionEndClock: 1_050 }, { wall });
        expect(crossed.observedUntil).toBeGreaterThan(1_050);
        expect(crossed.reply).toMatchObject({ ok: true, submitted: false, refused: 'deadline_exceeded', reasons: [] });
        expect(crossed.sends).toEqual([]);
        // The command cutoff passing during the observation stops it the same way.
        const commandCrossed = await run(action, { commandEndClock: 1_050, actionEndClock: 100_000 }, { wall });
        expect(commandCrossed.reply).toMatchObject({ submitted: false, refused: 'deadline_exceeded' });
        expect(commandCrossed.sends).toEqual([]);
        // With both cutoffs ahead at the request, the request is sent exactly once.
        const inTime = await run(action, { commandEndClock: 100_000, actionEndClock: 5_000 }, { wall });
        expect(inTime.reply).toMatchObject({ ok: true, submitted: true, acknowledged: true });
        expect(inTime.sends).toEqual([action === 'prompt' ? '/session/ses_a/prompt_async' : '/session/ses_a/abort']);
      }
      // A missing effect cutoff, or one sent in the old wall-clock fields, has already passed.
      for (const cutoffs of [{ commandEndClock: 100_000 }, { commandEndClock: 100_000, deadlineAt: wallAhead, deadlineMs: 60_000 }]) {
        const missing = await run('prompt', cutoffs, { wall });
        expect(missing.reply).toMatchObject({ submitted: false, refused: 'deadline_exceeded' });
        expect(missing.sends).toEqual([]);
      }
    }
    expect(driverBudget({ deadlineMs: 60_000, deadlineAt: wallAhead }, () => 0)()).toBe(0);
    expect(driverBudget({ commandEndClock: 1_500 }, () => 1_000)()).toBe(500);
  });

  test('a late exec gains no fresh budget: a Node driver that starts after its command cutoff observes and sends nothing', async () => {
    const driverPath = join(import.meta.dir, 'exercise-driver.ts');
    const nodeClock = () => Number(spawnSync('node', ['-e', 'process.stdout.write(String(Number(process.hrtime.bigint() / 1000n) / 1000))'], { encoding: 'utf8' }).stdout);
    const run = (command: string, input: any) => JSON.parse(spawnSync('node', [driverPath, command], { input: JSON.stringify(input), encoding: 'utf8' }).stdout.trim());
    // The cutoff is 300 ms ahead when computed; the driver starts 600 ms later.
    const end = nodeClock() + 300;
    await new Promise((r) => setTimeout(r, 600));
    const late = { host: 'v1', trusted: false, commandEndClock: end, actionEndClock: end, sessionId: 'ses_a', op: { kind: 'interrupt', sessionId: 'ses_a' } };
    expect(run('submit', late)).toEqual({ ok: false, failure: 'deadline_exceeded', submitted: false });
    expect(run('observe', late)).toEqual({ ok: false, failure: 'deadline_exceeded', submitted: false });
    // No cutoff, or only the old relative and wall-clock fields, is no budget at all.
    expect(run('catalog', { host: 'v1', trusted: false })).toEqual({ ok: false, failure: 'deadline_exceeded', submitted: false });
    expect(run('catalog', { host: 'v1', trusted: false, deadlineMs: 50_000, deadlineAt: Date.now() + 50_000 })).toEqual({ ok: false, failure: 'deadline_exceeded', submitted: false });
  });

  test('a fractional remaining budget reaches the real strictApi under Node as whole milliseconds: floored, and refused unsent below one millisecond', () => {
    const urlOf = (file: string) => JSON.stringify(pathToFileURL(join(import.meta.dir, file)).href);
    // Node rejects a fractional timeout with ERR_OUT_OF_RANGE; Bun does not, so this runs the real modules under Node.
    const script = `
      const { strictApi, wholeMs } = await import(${urlOf('container-runtime.ts')});
      const { budget } = await import(${urlOf('exercise-driver.ts')});
      process.env.OPENCODE_SERVER_PASSWORD = 'x';
      let sent = 0;
      // The abort timer does not hold Node open, so a stub that waits on it needs something that does.
      const keepAlive = setInterval(() => {}, 100);
      const answer = async () => { sent++; return new Response('{}', { status: 200 }); };
      const hang = (url, { signal }) => { sent++; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))); };
      const run = async (remainingMs, fetchImpl) => {
        const before = sent;
        const started = performance.now();
        try {
          const result = await strictApi('/x', { timeoutMs: remainingMs, fetchImpl });
          return { outcome: result.outcome, sent: sent - before, ms: performance.now() - started };
        } catch (error) { return { thrown: error.code ?? String(error), sent: sent - before }; }
      };
      const out = { answered: [], refused: [] };
      for (const end of [10_000.25, 8_999.925, 10_000]) out.answered.push(await run(budget({ commandEndClock: end }, () => 0)(), answer));
      out.hung = await run(budget({ commandEndClock: 40.75 }, () => 0)(), hang);
      for (const end of [0.999, 0.5, 0, -3]) out.refused.push(await run(budget({ commandEndClock: end }, () => 0)(), answer));
      out.refused.push(await run(Number.NaN, answer));
      out.whole = [10.9, 1, 0.9, Number.NaN, 600000.5].map(wholeMs);
      clearInterval(keepAlive);
      process.stdout.write(JSON.stringify(out));
    `;
    const ran = spawnSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000 });
    expect(ran.stderr).toBe('');
    const out = JSON.parse(ran.stdout);
    expect(out.answered.map((r: any) => [r.outcome, r.sent])).toEqual([['response', 1], ['response', 1], ['response', 1]]);
    // A 40.75 ms budget becomes a 40 ms timer that fires: the request was sent and then timed out, not left hanging.
    expect(out.hung).toMatchObject({ outcome: 'timeout', sent: 1 });
    expect(out.hung.ms).toBeLessThan(2_000);
    // Exhausted and submillisecond budgets send nothing.
    expect(out.refused.map((r: any) => [r.outcome, r.sent])).toEqual(Array(5).fill(['timeout', 0]));
    expect(out.whole).toEqual([10, 1, 0, 0, 600000]);
    // Every other timer in the in-container sources takes whole milliseconds too (spawnSync reads 0 as no timeout at all).
    for (const file of ['container-runtime.ts', 'exercise-driver.ts', 'fixture.ts']) {
      const source = readFileSync(join(import.meta.dir, file), 'utf8');
      for (const m of source.matchAll(/AbortSignal\.timeout\(([^)]*)\)|\btimeout: ([^,}]*)[,}]/g)) {
        const argument = (m[1] ?? m[2]).trim();
        expect([file, argument, /^[\d_]+$/.test(argument) || argument.startsWith('wholeMs(') || argument === 'wholeTimeout']).toEqual([file, argument, true]);
      }
    }
  });

  test('Node processes read one shared clock: a driver reading falls between two guard-clock readings, and a per-process clock does not', () => {
    const guardModule = join(import.meta.dir, 'guard.mjs');
    const guardClock = () => Number(spawnSync('node', ['-e', `import(${JSON.stringify(guardModule)}).then((m) => process.stdout.write(String(m.sharedClockMs())))`], { encoding: 'utf8' }).stdout);
    const before = guardClock();
    const reply = JSON.parse(spawnSync('node', [join(import.meta.dir, 'exercise-driver.ts'), 'clock'], { input: JSON.stringify({ host: 'v1', trusted: false, commandEndClock: before + 60_000 }), encoding: 'utf8' }).stdout.trim());
    const after = guardClock();
    expect(parseDriverReply('clock', reply)).toEqual(reply);
    expect(sharedClockBracket(before, reply.clockMs, after)).toBe(true);
    expect(sharedClockBracket(before, reply.processMs, after)).toBe(false);
    expect(typeof sharedClockMs()).toBe('number');
  });

  test('the host records a refusal for a driver that sent nothing, and a lost reply stays unknown', async () => {
    const docker = new ExerciseDocker({ driver: { submit: () => ({ ok: false, failure: 'deadline_exceeded', submitted: false }) } });
    const r1 = exerciseRun();
    const refused = await turnCommand({ run: r1.runDir, operation: r1.op('prompt', { text: 'x' }, 'p1') }, r1.env, {}, { docker });
    expect(refused.status).toMatchObject({ state: 'refused', reason: 'deadline_exceeded' });
    expect(runState(r1.journal).unresolved).toEqual([]);
    const refusedAtRequest = new ExerciseDocker({ driver: { submit: () => ({ ok: true, submitted: false, refused: 'deadline_exceeded', reasons: [] }) } });
    const r2 = exerciseRun();
    expect((await turnCommand({ run: r2.runDir, operation: r2.op('prompt', { text: 'x' }, 'p1') }, r2.env, {}, { docker: refusedAtRequest })).status).toMatchObject({ state: 'refused', reason: 'deadline_exceeded' });
    expect(runState(r2.journal).unresolved).toEqual([]);
    const lost = new ExerciseDocker({ driver: { submit: () => ({ ok: true, submitted: true, acknowledged: null }) } });
    const r3 = exerciseRun();
    expect((await turnCommand({ run: r3.runDir, operation: r3.op('prompt', { text: 'x' }, 'p1') }, r3.env, {}, { docker: lost })).status.state).toBe('unknown');
  });

  test('an operation carrying the original token, a fragment of it or a token shape latches the run before anything is recorded, sent or echoed; clean input cannot resume it', async () => {
    const fragment = FAKE_ACCESS.slice(3, 35);
    expect(fragment).toHaveLength(32);
    const escaped = FAKE_ACCESS.split('').map((ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    const pending = released({ kind: 'question', id: 'que_1', sessionId: 'ses_primary', toolCallId: 'call_q', questions: [{ question: 'Which?', header: null, multiple: false, options: ['alpha'], optionDescriptions: ['first'] }] });
    const cases: [string, any, string?][] = [
      ['reply', { requestId: 'que_1', answers: [[FAKE_ACCESS]] }],
      ['reply', { requestId: 'que_1', answers: [['alpha']] }, fragment],
      ['prompt', { text: `see ${fragment}` }],
      ['approve-plan', { project: PROJECT_ROOT, feature: 'f', revision: fragment, contentHash: 'h1', permittedWork: 'edit' }],
      ['prompt', { text: 'sk-' + 'q'.repeat(24) }],
    ];
    for (const [action, fields, id] of cases) {
      const docker = new ExerciseDocker({ driver: { observe: () => ({ ...QUIET, quiescent: false, pending }), submit: () => ({ ok: true, submitted: true, acknowledged: true }) } });
      const run = exerciseRun();
      const result = await turnCommand({ run: run.runDir, operation: run.op(action, fields, id ?? 'op-1') }, run.env, {}, { docker });
      expect(result).toEqual({ exit: EXIT.invalid, status: { command: 'turn', status: 'refused', reason: 'operation_contaminated', latched: true } });
      expect(docker.driverCalls).toEqual([]);
      expect(run.journal.names().some((n) => n.startsWith('op.'))).toBe(false);
      expect(run.journal.read('latch')!.value.code).toBe('operation_contaminated');
      for (const name of run.journal.names()) expect(JSON.stringify(run.journal.read(name))).not.toContain(fragment);
      // The latch is permanent: a clean operation is refused without a driver call or a record, and inspect exports nothing.
      const clean = await turnCommand({ run: run.runDir, operation: run.op('prompt', { text: 'a clean message' }, 'clean-1') }, run.env, {}, { docker });
      expect(clean.status).toMatchObject({ status: 'refused', reason: 'run_latched', latch: 'operation_contaminated' });
      expect((await inspectCommand({ run: run.runDir, request: run.inspection({ conversation: {} }) }, run.env, { docker })).status).toMatchObject({ status: 'content_unavailable', lifecycle: { latched: 'operation_contaminated' } });
      expect(docker.driverCalls).toEqual([]);
      expect(run.journal.names().some((n) => n.startsWith('op.'))).toBe(false);
      expect(existsSync(join(run.runDir, 'evidence'))).toBe(false);
    }
    // A token carried as escape sequences in the file is found in the decoded value.
    const docker = new ExerciseDocker({ driver: { submit: () => ({ ok: true, submitted: true, acknowledged: true }) } });
    const run = exerciseRun();
    const file = join(run.runDir, 'escaped-op.json');
    writeFileSync(file, `{"schema":"ic-exercise-operation/v1","id":"e1","runId":"run-1","sessionId":"ses_primary","action":"prompt","text":"${escaped}"}`);
    expect(readFileSync(file, 'utf8')).not.toContain(FAKE_ACCESS);
    expect((await turnCommand({ run: run.runDir, operation: file }, run.env, {}, { docker })).status).toEqual({ command: 'turn', status: 'refused', reason: 'operation_contaminated', latched: true });
    expect(docker.driverCalls).toEqual([]);
    expect(run.journal.read('latch')!.value.code).toBe('operation_contaminated');
  });

  test('an inspection request carrying the token latches the run the same way: nothing is observed, and a clean request later exports nothing', async () => {
    const docker = new ExerciseDocker({ driver: { observe: () => ({ ...QUIET }) } });
    const run = exerciseRun();
    const refused = await inspectCommand({ run: run.runDir, request: run.inspection({ resolve: FAKE_ACCESS }) }, run.env, { docker });
    expect(refused).toEqual({ exit: EXIT.invalid, status: { command: 'inspect', status: 'refused', reason: 'inspection_contaminated', latched: true } });
    expect(JSON.stringify(refused)).not.toContain(FAKE_ACCESS);
    expect(run.journal.read('latch')!.value.code).toBe('inspection_contaminated');
    const clean = await inspectCommand({ run: run.runDir, request: run.inspection({ conversation: {} }) }, run.env, { docker });
    expect(clean.status).toMatchObject({ status: 'content_unavailable', lifecycle: { latched: 'inspection_contaminated' } });
    expect(docker.driverCalls).toEqual([]);
    expect(existsSync(join(run.runDir, 'evidence'))).toBe(false);
  });

  test('a start authorization that fails its scan latches the run before any intent or resource; a clean authorization cannot start it', async () => {
    const docker = new ExerciseDocker();
    const run = exerciseRun();
    const prepared = runState(run.journal).prepared!;
    const authorization = (authorizedBy: string) => {
      const path = join(run.runDir, `authorization-${authorizedBy.length}.json`);
      writeFileSync(path, JSON.stringify({
        schema: 'ic-exercise-authorization/v1', runId: 'run-1', preparedSha256: prepared.sha256, host: 'v1', model: prepared.value.request.model, budgetSeconds: 900,
        allowedActions: ['prompt'], stopConditions: ['done'], authorizedBy,
      }));
      return path;
    };
    const attempt = async (authorizedBy: string) => { try { await startCommand({ run: run.runDir, authorization: authorization(authorizedBy), budgetSeconds: 900 }, run.env, {}, { docker }); return 'started'; } catch (e) { return [(e as HarnessError).code, (e as HarnessError).detail ?? null]; } };
    expect(await attempt('sk-' + 'a'.repeat(24))).toEqual(['authorization_contaminated', null]);
    expect(run.journal.read('latch')!.value.code).toBe('authorization_contaminated');
    expect(run.journal.read('start.intent')).toBeNull();
    expect((await attempt('supervisor'))[0]).toBe('run_latched');
    expect(docker.calls).toEqual([]);
    expect(run.journal.read('start.intent')).toBeNull();
  });

  test('a run directory named with a token shape fails the release gate and is never echoed', async () => {
    const shape = 'sk-' + 'w'.repeat(24);
    const docker = new ExerciseDocker({ driver: { observe: () => ({ ...QUIET }) } });
    const run = exerciseRun({ name: `run-${shape}` });
    const result = await inspectCommand({ run: run.runDir }, run.env, { docker });
    expect(result).toEqual({ exit: EXIT.failed, status: { command: 'inspect', lifecycle: expect.any(Object), status: 'content_unavailable', reason: 'evidence_contaminated' } });
    expect(JSON.stringify(result)).not.toContain(shape);
    expect(existsSync(join(run.runDir, 'evidence'))).toBe(false);
    expect(JSON.stringify(await inspectCommand({ run: run.runDir }, run.env, { docker }))).not.toContain(shape);
  });

  test('statuses with no scanner for the original token carry only closed controller facts: an opaque token in the run path is never echoed, first or later', async () => {
    // FAKE_ACCESS has no token shape: only a scanner built from the exact token can see it, and cleanup never has one.
    const opaque = FAKE_ACCESS;
    expect(evidenceScanner(null)(opaque)).toBe(false);
    const docker = new ExerciseDocker({ driver: { observe: () => ({ ...QUIET }) } });
    const run = exerciseRun({ name: `run-${opaque}` });
    // First failure, with the exact scanner: the release gate finds the token in the evidence path and latches.
    const first = await inspectCommand({ run: run.runDir }, run.env, { docker });
    expect(first.status).toMatchObject({ status: 'content_unavailable', reason: 'evidence_contaminated' });
    expect(run.journal.read('latch')!.value.code).toBe('evidence_contaminated');
    // Later commands are scanner-free. Their output names no path, and the credential file is gone.
    const noAuth = { IC_EXERCISE_AUTH_PATH: join(run.runDir, 'absent-auth.json') };
    const later = await inspectCommand({ run: run.runDir, request: run.inspection({ conversation: {} }) }, noAuth, { docker });
    expect(later).toMatchObject({ exit: EXIT.failed, status: { command: 'inspect', status: 'content_unavailable', lifecycle: { latched: 'evidence_contaminated', stopped: false } } });
    expect(later.status).not.toHaveProperty('run');
    const turned = await turnCommand({ run: run.runDir, operation: run.op('prompt', { text: 'x' }) }, noAuth, {}, { docker });
    expect(turned.status).toMatchObject({ status: 'refused', reason: 'run_latched' });
    // Stop reads neither the environment nor any credential file, and sends nothing into the container.
    require('node:fs').unlinkSync(run.auth);
    const untouched = new Proxy({}, { get: (_, key) => { throw new Error(`stop consulted env ${String(key)}`); } });
    const stopDocker = new ExerciseDocker();
    const stopped = await stopCommand({ run: run.runDir }, untouched, { docker: stopDocker });
    expect(stopped).toEqual({ exit: EXIT.ok, status: { command: 'stop', status: 'cleanup_confirmed', retained: [], retainedImages: ['sha256:image'] } });
    expect(stopDocker.calls.some((c) => c.args[0] === 'exec')).toBe(false);
    const afterStop = await inspectCommand({ run: run.runDir }, noAuth, { docker });
    expect(afterStop.status).toMatchObject({ status: 'content_unavailable', lifecycle: { stopped: true } });
    // Only the run directory's own records, which the caller already holds, may carry the path.
    for (const output of [first, later, turned, stopped, afterStop]) expect(JSON.stringify(output)).not.toContain(opaque);
    for (const name of run.journal.names()) expect(JSON.stringify(run.journal.read(name))).not.toContain(opaque);
    expect(docker.driverCalls.filter((c) => c.command !== 'observe')).toEqual([]);
  });

  test('prepare names no path in its status: a failed prepare prints closed controller facts only', async () => {
    const root = scratch();
    const runId = `run-${FAKE_ACCESS}`;
    expect(runId.length).toBeLessThanOrEqual(64);
    const result = await prepareCommand({ 'output-root': root, 'run-id': runId, host: 'v1', input: join(root, 'absent-request.json'), 'candidate-ref': 'a'.repeat(40) }, {});
    expect(result.exit).toBe(EXIT.failed);
    expect(result.status).toEqual({
      command: 'prepare', status: 'failed', preparedSha256: expect.stringMatching(/^[0-9a-f]{64}$/), failures: [expect.stringMatching(/^[a-z_]+$/)], qualification: null, retainedImages: [],
    });
    expect(JSON.stringify(result)).not.toContain(FAKE_ACCESS);
    expect(JSON.stringify(result)).not.toContain(root);
  });

  test('a delayed old effect is never replayed: a timed-out submission stays unknown, blocks every effect, and resolves only by exact evidence', async () => {
    const docker = new ExerciseDocker({ timeout: ['submit'], driver: { observe: () => ({ ...QUIET, resolution: { resolved: false } }) } });
    const run = exerciseRun();
    const first = await turnCommand({ run: run.runDir, operation: run.op('prompt', { text: 'x' }, 'p1') }, run.env, {}, { docker });
    expect(first).toMatchObject({ exit: EXIT.busy, status: { state: 'unknown', reason: 'driver_timeout' } });
    for (const [action, fields] of [['prompt', { text: 'again' }], ['interrupt', {}], ['reply', { requestId: 'que_1', answers: [['a']] }], ['permission', { requestId: 'per_1', decision: 'once' }], ['switch-primary', { to: 'swarm-orchestrator' }]] as any[]) {
      expect((await turnCommand({ run: run.runDir, operation: run.op(action, fields) }, run.env, {}, { docker })).status).toMatchObject({ status: 'blocked', reason: 'operation_unresolved' });
    }
    expect(submits(docker).length).toBe(1);
    await inspectCommand({ run: run.runDir, request: run.inspection({ resolve: 'p1' }) }, run.env, { docker });
    expect(runState(run.journal).unresolved).toEqual(['p1']);
    // The old process may still land its request later; the exact message ID is what shows it did.
    docker.behavior.driver.observe = (input: any) => ({ ...QUIET, resolution: input.resolve?.messageId === submits(docker)[0].input.op.messageId ? { resolved: true, effect: 'accepted' } : { resolved: false } });
    await inspectCommand({ run: run.runDir, request: run.inspection({ resolve: 'p1' }) }, run.env, { docker });
    expect(runState(run.journal).unresolved).toEqual([]);
  });

  test('a lost reply, permission decision or interrupt stays unknown when only pending, idle or absent evidence exists', async () => {
    for (const [action, fields, kind] of [['reply', { requestId: 'que_1', answers: [['alpha']] }, 'question'], ['permission', { requestId: 'per_1', decision: 'once' }, 'permission'], ['interrupt', {}, 'interrupt']] as any[]) {
      const pending = kind === 'interrupt' ? [] : released({ kind, id: fields.requestId, sessionId: 'ses_child', toolCallId: 'call_x', ...(kind === 'question' ? { questions: [{ question: 'Q?', header: null, multiple: false, options: ['alpha'], optionDescriptions: ['first'] }] } : { permission: { action: 'read', resources: [] } }) });
      const docker = new ExerciseDocker({ driver: { observe: () => ({ ...QUIET, pending, quiescent: false }), submit: () => ({ ok: true, submitted: true, acknowledged: null }) } });
      const run = exerciseRun();
      const lost = await turnCommand({ run: run.runDir, operation: run.op(action, fields, 'lost') }, run.env, {}, { docker });
      expect(lost.status.state).toBe('unknown');
      // The request is still pending, then gone, then the session idle: none of these names the operation.
      for (const observed of [{ ...QUIET, pending, resolution: { resolved: false } }, { ...QUIET, pending: [], resolution: { resolved: false } }]) {
        docker.behavior.driver.observe = () => observed;
        await inspectCommand({ run: run.runDir, request: run.inspection({ resolve: 'lost' }) }, run.env, { docker });
        expect(runState(run.journal).unresolved).toEqual(['lost']);
      }
      expect((await turnCommand({ run: run.runDir, operation: run.op('prompt', { text: 'next' }) }, run.env, {}, { docker })).status.reason).toBe('operation_unresolved');
    }
  });

  test('native session and background stores of both owners are excluded at every supported layout and resolved path', () => {
    for (const path of ['.hive/sessions.json', '.hive/background-jobs.json', '.hive/runtime/opencode-v2/sessions.json', '.hive/runtime/opencode-v2/background-jobs.json', '.hive/runtime/',
      '.hive/features/01_f/sessions.json', '.hive/features/f/sessions.json', '.hive/features/01_f/runtime/opencode-v2/sessions.json', '.hive/features/01_f/runtime/', '.hive/features/f/runtime/x']) {
      expect([path, nativeStorePath(path)]).toEqual([path, true]);
      expect(() => projectPath(path)).toThrow();
    }
    for (const path of ['.hive/features/', '.hive/features/01_f/plan.md', '.hive/features/01_f/tasks/01_t/status.json', '.hive/context/notes.md', '.hive/features/01_f/context/runtime.md', 'src/runtime/sessions.json', 'README.md']) {
      expect([path, nativeStorePath(path)]).toEqual([path, false]);
    }
    expect(() => validateRequest({ ...EXERCISE_REQUEST, artifacts: ['.hive/features/01_f/sessions.json'] })).toThrow();
    expect(() => validateRequest({ ...EXERCISE_REQUEST, artifacts: ['.hive/features/01_f/runtime/'] })).toThrow();
    const inspection = (value: any) => { try { validateInspection({ schema: 'ic-exercise-inspection/v1', runId: 'r1', ...value }, { runId: 'r1', artifacts: ['.hive/features/'] }); return 'accepted'; } catch (e) { return (e as HarnessError).code; } };
    expect(inspection({ artifacts: ['.hive/features/01_f/plan.md'] })).toBe('accepted');
    expect(inspection({ artifacts: ['.hive/features/01_f/sessions.json'] })).toBe('inspection_path_invalid');
    expect(inspection({ list: ['.hive/features/01_f/runtime/'] })).toBe('inspection_path_invalid');
    // The driver holds the resolved path to the same rule: a link or hardlink into a native store, or into an excluded tree, is refused.
    const root = scratch();
    const feature = join(root, '.hive', 'features', '01_f');
    mkdirSync(join(feature, 'runtime', 'opencode-v2'), { recursive: true });
    writeFileSync(join(feature, 'sessions.json'), '{"sessions":[]}');
    writeFileSync(join(feature, 'runtime', 'opencode-v2', 'sessions.json'), '{}');
    writeFileSync(join(feature, 'plan.md'), '# plan\n');
    symlinkSync(join(feature, 'sessions.json'), join(feature, 'notes.md'));
    linkSync(join(feature, 'sessions.json'), join(feature, 'copy.md'));
    const scan = () => false;
    expect(artifactRecord('.hive/features/01_f/plan.md', scan, root)).toMatchObject({ path: '.hive/features/01_f/plan.md', text: '# plan\n' });
    for (const path of ['.hive/features/01_f/sessions.json', '.hive/features/01_f/runtime/opencode-v2/sessions.json', '.hive/features/01_f/notes.md', '.hive/features/01_f/copy.md']) {
      expect(artifactRecord(path, scan, root)).toEqual({ path, omitted: 'path_rejected' });
    }
  });

  test('a requested inventory is bounded, scanned and allowlisted: links, hardlinks, native stores and excluded trees are counted, not listed', () => {
    const root = scratch();
    const feature = join(root, '.hive', 'features', '01_f');
    mkdirSync(join(feature, 'runtime'), { recursive: true });
    mkdirSync(join(feature, 'tasks', '01_t'), { recursive: true });
    mkdirSync(join(feature, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(feature, 'plan.md'), '# plan\n');
    writeFileSync(join(feature, 'tasks', '01_t', 'status.json'), '{}');
    writeFileSync(join(feature, 'sessions.json'), '{}');
    writeFileSync(join(feature, 'runtime', 'sessions.json'), '{}');
    writeFileSync(join(feature, 'node_modules', 'dep', 'x.js'), 'x');
    writeFileSync(join(feature, 'a.md'), 'a');
    linkSync(join(feature, 'a.md'), join(feature, 'b.md'));
    symlinkSync(join(feature, 'plan.md'), join(feature, 'link.md'));
    writeFileSync(join(feature, 'weird name\u0001.md'), 'w');
    const listed = listPrefix('.hive/features/', () => false, root);
    expect(listed.entries.map((e: any) => e.path)).toEqual(['.hive/features/01_f/plan.md', '.hive/features/01_f/tasks/01_t/status.json']);
    expect(listed).toMatchObject({ complete: true, absent: false, rejected: false, omitted: { links: 1, special: 2, excluded: 3, names: 1 } });
    expect(listed.entries[0]).toEqual({ path: '.hive/features/01_f/plan.md', bytes: 7 });
    // Rejected, absent and linked prefixes.
    expect(listPrefix('.hive/runtime/', () => false, root)).toMatchObject({ rejected: true, entries: [] });
    expect(listPrefix('.hive/features', () => false, root)).toMatchObject({ rejected: true });
    expect(listPrefix('.hive/features/01_f/runtime/', () => false, root)).toMatchObject({ rejected: true });
    expect(listPrefix('src/', () => false, root)).toMatchObject({ absent: true, rejected: false, entries: [] });
    symlinkSync(feature, join(root, 'linked'));
    expect(listPrefix('linked/', () => false, root)).toMatchObject({ rejected: true, entries: [] });
    // A link along the prefix, not only at its end: `alias` names the native store directory, so `alias/opencode-v2/`
    // is lexically ordinary and resolves into the store. The listing is refused, and so is a link into an allowed tree.
    mkdirSync(join(root, '.hive', 'runtime', 'opencode-v2'), { recursive: true });
    writeFileSync(join(root, '.hive', 'runtime', 'opencode-v2', 'sessions.json'), '{"sessions":[]}');
    symlinkSync(join(root, '.hive', 'runtime'), join(root, 'alias'));
    expect(listPrefix('alias/opencode-v2/', () => false, root)).toMatchObject({ rejected: true, entries: [] });
    mkdirSync(join(root, 'docs'));
    symlinkSync(feature, join(root, 'docs', 'feature'));
    expect(listPrefix('docs/feature/tasks/', () => false, root)).toMatchObject({ rejected: true, entries: [] });
    for (const path of ['alias/opencode-v2/sessions.json', 'docs/feature/plan.md']) expect(artifactRecord(path, () => false, root)).toEqual({ path, omitted: 'path_rejected' });
    expect(artifactRecord('.hive/features/01_f/plan.md', () => false, root)).toMatchObject({ text: '# plan\n' });
    // A name carrying the token stops the whole export.
    writeFileSync(join(root, '.hive', 'features', `01_f-${FAKE_ACCESS}.md`), 'x');
    expect(() => listPrefix('.hive/features/', evidenceScanner({ access: FAKE_ACCESS, expires: 1 }), root)).toThrow();
    // Caps: the entry cap ends the listing and says it is incomplete.
    const many = join(root, 'many');
    mkdirSync(many);
    for (let i = 0; i < 1001; i++) writeFileSync(join(many, `f${String(i).padStart(4, '0')}.txt`), 'x');
    const capped = listPrefix('many/', () => false, root);
    expect(capped.entries.length).toBe(1000);
    expect(capped.complete).toBe(false);
    let deep = join(root, 'deep');
    for (let i = 0; i < 14; i++) deep = join(deep, `d${i}`);
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'leaf.txt'), 'x');
    expect(listPrefix('deep/', () => false, root).complete).toBe(false);
  });

  test('qualification passes only when every named check was observed true, including the lost-reply and lock checks', () => {
    for (const name of ['protocol.replyAckLost', 'protocol.permissionStaysUnknown', 'protocol.switchAckLostSafe', 'protocol.lateDriverSendsNothing', 'protocol.lockSurvivesNoDescendant', 'interrupt.staysUnknown', 'interrupt.noReplay',
      'protocol.actionCutoffSendsNothing', 'protocol.directPlanRead', 'protocol.directApproval', 'clock.sharedDomain', 'clock.processClockRefused']) {
      expect(QUALIFICATION_CHECKS).toContain(name);
    }
  });
});
