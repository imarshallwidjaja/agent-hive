// Synthetic boundary, isolation, evidence and lifecycle tests. No Docker engine, network or real credential is used:
// the Docker CLI is replaced by an in-memory fake and every credential below is a made-up string.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  HarnessError, Journal, Resources, STATUS_EXIT, artifactFailures, assessContainerIsolation, assessDockerBoundary, candidateBindingMismatches, caseSummary,
  checkCriterion, classifyCase, classifyCorePattern, containerCreateArgs, createRunDir, effectiveSettings, failedChecks, finalExit, loadRunRecords,
  hostPreflight, modelEvidenceFailures, outstandingFromLedger, paidCase, parseCli, prepareResume, recordReadFailures, rehearsalPathFailures, rehearseInjection,
  modelSelectionFailures, rehearseLifetime, rehearsePaidPath, rehearseSelection, resumePlan, runEndFailure, runtimeFailures, selectScenarios, selectSharedModel, verifyArtifact,
  verifyResumeOrigins, wiringFailures,
} from './run.mjs';
import {
  ARTIFACT_CAP, ATTEMPT_LOG_HEADER, FINAL_TEXT_CAP, STOP_INSTRUCTION_CAP, allowlistArgs, attemptCount, clipText, clipToolArgs, codeModeBlocks, codeModeFieldDocs, commandDelivery,
  classifyEditAttempt, containerSecrets, deliveredBodySentence, evidenceLimits, exportDecision, hiveResultFailed, interruptSession, messagePages, mockDecision, preflightReply, readHistories, render, runPrompt, safeName, refusalKind, scenarioOverrides,
  scriptDirective, skillReferencePointers, toolFieldContract, toolOutcome,
} from './fixture.ts';

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
  calls: { args: string[]; input?: string }[] = [];
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
    this.calls.push({ args, input: options.input });
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
