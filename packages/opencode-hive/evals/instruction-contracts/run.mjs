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
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync,
  statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { release } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CredentialError, assertLifetime, fingerprintAuthFile, hostAuthPath, readAccessOnly, sameFingerprint, secretScanner } from './credentials.mjs';
import { GUARD_EXIT_CODE, GUARD_UID } from './guard.mjs';
import { HOST_IDS, authRequest, requiredLifetimeMs } from './hosts.mjs';

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_REL = 'packages/opencode-hive/evals/instruction-contracts';
const FIXTURE = '/opt/ic/harness/fixture.ts';
const GUARD = '/opt/ic/harness/guard.mjs';
const AGENT_USER = '1000:1000';
const GUARD_USER = `${GUARD_UID}:${GUARD_UID}`;
const MAX_DEADLINE_SECONDS = 600;
const LIFETIME_MARGIN_MS = 10 * 60_000;
// Container lifetime ceilings, enforced inside each container by guard.mjs. A credential-bearing container also gets a
// shorter one-shot deadline armed immediately before injection.
const CEILING = { rehearsal: 1500, wiring: 3600, auxiliary: 900, paidSetup: 1260 };
const AUXILIARY_DEADLINE_SECONDS = 300;
// Bounded RAM for every scenario container, equal to its memory+swap limit so no container page can swap.
const CONTAINER_MEMORY = '4g';
const CONTAINER_MEMORY_BYTES = 4 * 1024 ** 3;
const STOCK_VERSIONS = { v1: '1.18.30', v2: '2.0.26' };
export const ISOLATION = Object.freeze({
  memory: CONTAINER_MEMORY, memorySwap: CONTAINER_MEMORY, logDriver: 'none', coreLimit: '1:1', corePatterns: ['pipe', 'file'],
  rootfs: 'read-only', tmpfs: ['/work', '/tmp'], agentUser: AGENT_USER, guardUser: GUARD_USER, init: 'docker-init',
});

const MANIFEST_SCHEMA = 'ic-run-manifest/v3';

// Run statuses and their process exit codes. `collected` means every selected case produced a safe, valid record; it
// says nothing about whether the instructions behaved well. `checkpoint` means a paid run stopped at a case boundary
// on purpose and can be continued with --resume-from; `incomplete` means some case needs an explicit repurchase
// decision.
export const STATUS_EXIT = { passed: 0, 'rehearsal-passed': 0, collected: 0, checkpoint: 3, incomplete: 1, failed: 1 };

export class HarnessError extends Error {
  constructor(code, detail) {
    super(`instruction-contracts: ${code}`);
    this.code = code;
    this.detail = detail;
  }
}

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
// Docker boundary

// Inherited settings that could redirect the CLI to another engine, builder, TLS identity or proxy.
const DOCKER_OVERRIDES = [
  'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_CONFIG',
  'DOCKER_API_VERSION', 'DOCKER_DEFAULT_PLATFORM', 'BUILDX_BUILDER', 'BUILDKIT_HOST', 'BUILDX_CONFIG',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
];

/** Decides whether the Docker engine is a trusted local engine. Unresolved locality fails closed. */
export function assessDockerBoundary({ env, endpoint, socketIsSocket, version, info, localKernel }) {
  const failures = [];
  for (const name of DOCKER_OVERRIDES) if (env[name] !== undefined) failures.push(`inherited_override:${name}`);
  const match = /^unix:\/\/(\/[^\s]+)$/.exec(endpoint ?? '');
  if (!match) failures.push('endpoint_not_local_unix_socket');
  if (!socketIsSocket) failures.push('endpoint_socket_missing');
  if (!version || !info) failures.push('engine_unreachable');
  else {
    if (info.OSType !== 'linux') failures.push('engine_not_linux');
    // A local engine runs on this machine's kernel (native Linux, or Docker Desktop's WSL2 distribution). A remote,
    // offloaded or separately virtualized engine reports a different kernel and is refused.
    if (!info.KernelVersion || info.KernelVersion !== localKernel) failures.push('engine_kernel_differs_from_local');
    if (info.MemoryLimit !== true) failures.push('memory_limit_unsupported');
    if (info.SwapLimit !== true) failures.push('swap_limit_unsupported');
    if (String(info.CgroupVersion) !== '2') failures.push('cgroup_v2_required');
    if (/cloud|offload/i.test(`${info.Name} ${info.OperatingSystem}`)) failures.push('engine_remote_marker');
    if (typeof info.ID !== 'string' || !info.ID) failures.push('engine_identity_missing');
  }
  return { ok: failures.length === 0, failures };
}

export class Docker {
  constructor({ endpoint, configDir }) {
    this.endpoint = endpoint;
    this.configDir = configDir;
  }

  env() {
    return { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: this.configDir, DOCKER_CONFIG: this.configDir, DOCKER_HOST: this.endpoint };
  }

  /** Runs the docker CLI. Output stays in memory; callers decide what, if anything, is retained. */
  run(args, { input, timeoutMs = 120_000, onSpawn } = {}) {
    return new Promise((resolvePromise) => {
      const child = spawn('docker', args, { env: this.env(), stdio: ['pipe', 'pipe', 'pipe'] });
      onSpawn?.(child);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      child.on('error', () => {});
      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise({ code: code ?? -1, stdout, stderr, timedOut });
      });
      child.stdin.on('error', () => {});
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });
  }

  async json(args, options) {
    const result = await this.run(args, options);
    if (result.code !== 0) return null;
    try { return JSON.parse(result.stdout); } catch { return null; }
  }
}

export async function verifyDockerBoundary(docker, env) {
  const socketPath = docker.endpoint.replace(/^unix:\/\//, '');
  let socketIsSocket = false;
  try { socketIsSocket = statSync(socketPath).isSocket(); } catch { socketIsSocket = false; }
  const version = await docker.json(['version', '--format', '{{json .}}']);
  const info = await docker.json(['info', '--format', '{{json .}}']);
  const verdict = assessDockerBoundary({ env, endpoint: docker.endpoint, socketIsSocket, version, info, localKernel: release() });
  return {
    ...verdict,
    engineId: info?.ID ?? null,
    observed: info ? {
      endpoint: docker.endpoint, engineId: info.ID ?? null, serverVersion: info.ServerVersion, operatingSystem: info.OperatingSystem, name: info.Name,
      kernel: info.KernelVersion, cgroupVersion: info.CgroupVersion, swapLimit: info.SwapLimit, memoryLimit: info.MemoryLimit,
      defaultLoggingDriver: info.LoggingDriver, daemonHttpProxy: info.HttpProxy || null, daemonHttpsProxy: info.HttpsProxy || null,
      clientVersion: version?.Client?.Version ?? null,
    } : null,
  };
}

// -----------------------------------------------------------------------------------------------------------------
// Owned resources. Every create carries a unique nonce label so a lost create response can be settled by exact ID.
// A resource is gone only when a successful listing from the same responsive engine no longer shows it; a Docker
// error, a timeout or an unparseable listing is `unknown`, which keeps the ID and stops further work.

const HEX64 = /^[0-9a-f]{64}$/;

export class Resources {
  constructor(docker, ledgerPath, runId, engineId) {
    this.docker = docker;
    this.ledgerPath = ledgerPath;
    this.runId = runId;
    this.engineId = engineId;
    this.live = new Map();
    this.pendingCreates = new Map();
    this.counts = { created: 0, removed: 0, stillPresent: 0, unknown: 0, retainedImages: [] };
  }

  record(entry) {
    appendFileSync(this.ledgerPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
    if (entry.event === 'created') this.counts.created++;
    if (entry.event === 'removed') this.counts.removed++;
    if (entry.event === 'image_retained') this.counts.retainedImages.push(entry.id);
  }

  labels(nonce) {
    return ['--label', `ic.run=${this.runId}`, '--label', `ic.nonce=${nonce}`];
  }

  /** Lists exact IDs through the bound engine. Returns null unless the engine is responsive and is the bound one. */
  async list(kind, filter) {
    const engine = await this.docker.run(['info', '--format', '{{.ID}}'], { timeoutMs: 30_000 });
    if (engine.code !== 0 || engine.timedOut || engine.stdout.trim() !== this.engineId) return null;
    const args = kind === 'network'
      ? ['network', 'ls', '-q', '--no-trunc', '--filter', filter]
      : ['ps', '-a', '-q', '--no-trunc', '--filter', filter];
    const result = await this.docker.run(args, { timeoutMs: 30_000 });
    if (result.code !== 0 || result.timedOut) return null;
    const lines = result.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    return lines.every((line) => HEX64.test(line)) ? lines : null;
  }

  /** 'present', 'absent' or 'unknown' for one exact ID. */
  async observe(kind, id) {
    const lines = await this.list(kind, `id=${id}`);
    if (lines === null) return 'unknown';
    if (lines.length === 0) return 'absent';
    return lines.includes(id) ? 'present' : 'unknown';
  }

  async create(kind, argsFor) {
    const nonce = randomUUID();
    this.record({ event: 'create_requested', kind, nonce });
    this.pendingCreates.set(nonce, kind);
    const result = await this.docker.run(argsFor(this.labels(nonce)), { timeoutMs: 120_000 });
    const direct = result.stdout.trim();
    if (result.code === 0 && HEX64.test(direct)) {
      this.pendingCreates.delete(nonce);
      this.live.set(direct, kind);
      this.record({ event: 'created', kind, nonce, id: direct, recovered: false });
      return direct;
    }
    await this.settleCreate(nonce, kind);
    throw new HarnessError(this.pendingCreates.has(nonce) ? 'create_unknown' : 'create_failed', { kind });
  }

  /** Settles a create whose response was lost: record every resource carrying its nonce, or confirm there is none. */
  async settleCreate(nonce, kind) {
    const ids = await this.list(kind, `label=ic.nonce=${nonce}`);
    if (ids === null) {
      this.record({ event: 'create_unknown', kind, nonce });
      return;
    }
    this.pendingCreates.delete(nonce);
    for (const id of ids) {
      this.live.set(id, kind);
      this.record({ event: 'created', kind, nonce, id, recovered: true });
    }
    if (ids.length === 0) this.record({ event: 'create_absent', kind, nonce });
  }

  /** Removes one owned resource by exact ID and confirms its absence; anything less stops the run. */
  async remove(id) {
    const kind = this.live.get(id);
    if (!kind) throw new HarnessError('resource_not_owned');
    if (kind === 'container') await this.docker.run(['kill', id], { timeoutMs: 30_000 });
    await this.docker.run(kind === 'network' ? ['network', 'rm', id] : ['rm', '-f', '-v', id], { timeoutMs: 60_000 });
    const state = await this.observe(kind, id);
    if (state === 'absent') {
      this.record({ event: 'removed', kind, id });
      this.live.delete(id);
      return 'absent';
    }
    this.record({ event: state === 'present' ? 'remove_unconfirmed' : 'remove_unknown', kind, id });
    throw new HarnessError(state === 'present' ? 'cleanup_unconfirmed' : 'cleanup_unknown', { kind });
  }

  /** Owned IDs with containers first: a network with an attached container cannot be removed. */
  removalOrder(ids = [...this.live.keys()]) {
    return ids.sort((a, b) => (this.live.get(a) === 'network') - (this.live.get(b) === 'network'));
  }

  async removeAll() {
    for (const [nonce, kind] of [...this.pendingCreates]) await this.settleCreate(nonce, kind);
    const results = [];
    for (const id of this.removalOrder()) {
      try {
        results.push({ id, state: await this.remove(id) });
      } catch (error) {
        results.push({ id, state: error?.code === 'cleanup_unconfirmed' ? 'present' : 'unknown' });
      }
    }
    for (const nonce of this.pendingCreates.keys()) results.push({ nonce, state: 'unknown' });
    this.counts.stillPresent = results.filter((r) => r.state === 'present').length;
    this.counts.unknown = results.filter((r) => r.state === 'unknown').length;
    return results;
  }

  /**
   * Settles the resources an earlier run's ledger leaves outstanding: every exact container or network ID it created
   * and did not confirm removed, and every create whose response was lost, looked up by its nonce. Each is removed by
   * exact ID through the bound engine and confirmed absent. A listing or removal that cannot be confirmed throws, so a
   * resume stops before any credential is read; there is no fallback to untracked Docker commands.
   */
  async settlePriorRun(runDir) {
    let text;
    try { text = readFileSync(join(runDir, 'resources.jsonl'), 'utf8'); } catch { throw new HarnessError('prior_ledger_missing'); }
    const { ids, nonces } = outstandingFromLedger(text);
    const before = new Set(this.live.keys());
    for (const [nonce, kind] of nonces) {
      this.pendingCreates.set(nonce, kind);
      await this.settleCreate(nonce, kind);
    }
    for (const [id, kind] of ids) {
      this.live.set(id, kind);
      this.record({ event: 'adopted', kind, id, from: runDir });
    }
    const adopted = this.removalOrder([...this.live.keys()].filter((id) => !before.has(id)));
    for (const id of adopted) await this.remove(id);
    if (this.pendingCreates.size > 0) throw new HarnessError('prior_resources_unsettled');
    return { runDir, outstandingIds: ids.size, outstandingNonces: nonces.size, removed: adopted.length };
  }

  get settled() {
    return this.live.size === 0 && this.pendingCreates.size === 0;
  }
}

/**
 * Resources an earlier run's ledger leaves outstanding. A create request stays outstanding until its resource is
 * recorded or its absence is; a created or adopted ID stays outstanding until a removal confirmed its absence. Retained
 * images are not run resources. An unreadable ledger cannot show that nothing is left, so it fails closed.
 */
export function outstandingFromLedger(text) {
  const ids = new Map();
  const nonces = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    let entry;
    try { entry = JSON.parse(line); } catch { throw new HarnessError('ledger_unreadable'); }
    const kindOk = entry.kind === 'container' || entry.kind === 'network';
    switch (entry.event) {
      case 'create_requested':
        if (!kindOk || typeof entry.nonce !== 'string') throw new HarnessError('ledger_unreadable');
        nonces.set(entry.nonce, entry.kind);
        break;
      case 'created':
      case 'adopted':
        if (!kindOk || !HEX64.test(entry.id)) throw new HarnessError('ledger_unreadable');
        ids.set(entry.id, entry.kind);
        nonces.delete(entry.nonce);
        break;
      case 'create_absent':
        nonces.delete(entry.nonce);
        break;
      case 'removed':
        ids.delete(entry.id);
        break;
      default:
        break;
    }
  }
  return { ids, nonces };
}

/** docker create arguments for one scenario container. Pure, so isolation settings are testable. */
export function containerCreateArgs({ image, labels, network, password, ceilingSeconds }) {
  return [
    'create', ...labels,
    // docker-init (tini) is PID 1 and the lifetime guard is its only child; the guard's exit ends the container.
    '--init',
    '--user', GUARD_USER,
    '--network', network,
    '--log-driver', 'none',
    '--memory', CONTAINER_MEMORY, '--memory-swap', CONTAINER_MEMORY,
    // RLIMIT_CORE=1 stops file dumps (below one page) and pipe helpers (fs/coredump.c refuses a pipe dump at a
    // limit of exactly 1). Socket core_pattern modes do not honor it and are refused by the isolation check.
    '--ulimit', 'core=1:1',
    '--pids-limit', '1024',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/work:rw,exec,nosuid,nodev,size=2g,mode=0700,uid=1000,gid=1000',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777',
    '-e', 'HOME=/work/home',
    '-e', 'XDG_CONFIG_HOME=/work/home/.config',
    '-e', 'XDG_DATA_HOME=/work/xdg/data',
    '-e', 'XDG_STATE_HOME=/work/xdg/state',
    '-e', 'XDG_CACHE_HOME=/work/xdg/cache',
    '-e', 'OPENCODE_DISABLE_AUTOUPDATE=1',
    '-e', 'OPENCODE_DISABLE_LSP_DOWNLOAD=true',
    '-e', `OPENCODE_SERVER_PASSWORD=${password}`,
    '-e', 'NPM_CONFIG_UPDATE_NOTIFIER=false',
    '--entrypoint', 'node',
    image, GUARD, 'serve', String(ceilingSeconds),
  ];
}

const ALLOWED_CONTAINER_ENV = new Set(['PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_LSP_DOWNLOAD', 'OPENCODE_SERVER_PASSWORD', 'NPM_CONFIG_UPDATE_NOTIFIER', 'NPM_CONFIG_FUND', 'NPM_CONFIG_AUDIT',
  'NODE_VERSION', 'YARN_VERSION']);

/**
 * Core-dump handling the 1:1 core limit is known to stop. A pipe helper (`|...`) is refused by the kernel at a limit of
 * exactly 1 before the helper starts; a file pattern needs at least one page. Socket modes (`@`, `@@`) and anything
 * unrecognized are refused rather than assumed safe.
 */
export function classifyCorePattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return 'unknown';
  if (pattern.startsWith('|')) return 'pipe';
  if (pattern.startsWith('@')) return 'socket';
  return /^[^\s]+$/.test(pattern) ? 'file' : 'unknown';
}

/** Checks the inspected container and what its processes observe before any credential is injected. */
export function assessContainerIsolation(inspect, probe, { network, ceilingSeconds }) {
  const failures = [];
  const host = inspect?.HostConfig ?? {};
  const config = inspect?.Config ?? {};
  if (host.LogConfig?.Type !== 'none') failures.push('logging_not_disabled');
  if (!(host.Memory > 0) || host.MemorySwap !== host.Memory) failures.push('memory_swap_not_equal');
  if (host.Memory !== CONTAINER_MEMORY_BYTES) failures.push('memory_not_fixed_allocation');
  if (host.Privileged) failures.push('privileged');
  if (host.NetworkMode !== network) failures.push('network_mode_unexpected');
  if (host.PublishAllPorts || Object.keys(host.PortBindings ?? {}).length > 0) failures.push('ports_published');
  if (host.PidMode || host.IpcMode === 'host' || host.UTSMode) failures.push('host_namespace');
  if ((host.Binds ?? []).length > 0 || (inspect?.Mounts ?? []).some((m) => m.Type !== 'tmpfs')) failures.push('non_tmpfs_mount');
  if (!host.ReadonlyRootfs) failures.push('root_writable');
  const core = (host.Ulimits ?? []).find((u) => u.Name === 'core');
  if (!core || core.Soft !== 1 || core.Hard !== 1) failures.push('core_limit_not_set');
  if (!(host.CapDrop ?? []).includes('ALL')) failures.push('capabilities_not_dropped');
  if (host.Init !== true) failures.push('init_not_enabled');
  if (config.User !== GUARD_USER) failures.push('guard_user_unexpected');
  if (JSON.stringify(config.Entrypoint) !== JSON.stringify(['node']) || JSON.stringify(config.Cmd) !== JSON.stringify([GUARD, 'serve', String(ceilingSeconds)])) failures.push('guard_command_unexpected');
  for (const entry of config.Env ?? []) {
    const name = entry.split('=')[0];
    if (!ALLOWED_CONTAINER_ENV.has(name)) failures.push(`env_not_allowlisted:${name}`);
  }
  if (!probe?.ok) failures.push('probe_failed');
  else {
    if (String(probe.swapMax) !== '0') failures.push('swap_not_zero_in_cgroup');
    if (String(probe.memoryMax) !== String(CONTAINER_MEMORY_BYTES)) failures.push('cgroup_memory_unexpected');
    if (!/^1 1 bytes$/.test(probe.coreLimit ?? '')) failures.push('core_limit_not_observed');
    if (!ISOLATION.corePatterns.includes(classifyCorePattern(probe.corePattern))) failures.push('core_pattern_unsupported');
    if (probe.work?.fstype !== 'tmpfs') failures.push('work_not_tmpfs');
    if (probe.tmp?.fstype !== 'tmpfs') failures.push('tmp_not_tmpfs');
    if (!/(^|,)ro(,|$)/.test(probe.root?.options ?? '')) failures.push('root_not_readonly_in_container');
    if ((probe.otherWritableMounts ?? []).length > 0) failures.push('unexpected_writable_mount');
    if (probe.uid !== 1000) failures.push('agent_uid_unexpected');
    if (probe.pid1 !== ISOLATION.init) failures.push('pid1_not_init');
    if (!probe.guard || probe.guard.uid !== GUARD_UID || probe.guard.ppid !== 1) failures.push('guard_not_observed');
  }
  return { ok: failures.length === 0, failures };
}

// -----------------------------------------------------------------------------------------------------------------
// Immutable run records. Each record is written to a temporary file, synced and published with link(2), which never
// replaces an existing name, so a record that exists is complete and cannot be rewritten by a later or concurrent run.

export class Journal {
  constructor(dir) {
    this.dir = dir;
  }

  static create(dir) {
    mkdirSync(dir);
    return new Journal(dir);
  }

  path(name) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new HarnessError('record_name_invalid');
    return join(this.dir, `${name}.json`);
  }

  write(name, value) {
    const final = this.path(name);
    const temp = join(this.dir, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    const text = JSON.stringify(value, null, 2) + '\n';
    const fd = openSync(temp, 'wx');
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, final);
    } catch (error) {
      throw new HarnessError(error?.code === 'EEXIST' ? 'record_exists' : 'record_write_failed', name);
    } finally {
      unlinkSync(temp);
    }
    return { name, sha256: sha256Text(text) };
  }

  read(name) {
    const file = this.path(name);
    if (!existsSync(file)) return null;
    const text = readFileSync(file, 'utf8');
    return { value: JSON.parse(text), sha256: sha256Text(text) };
  }

  names() {
    return existsSync(this.dir) ? readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort() : [];
  }
}

// -----------------------------------------------------------------------------------------------------------------
// Identities, builds and manifests

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function gitOut(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 });
  if (result.status !== 0) throw new HarnessError('git_failed', args[0]);
  return result.stdout;
}

/** Resolves refs once and refuses an uncommitted harness: the evaluated harness must be one committed revision. */
export function resolveIdentities({ repoRoot, subjectRef }) {
  const subjectCommit = gitOut(['rev-parse', '--verify', `${subjectRef}^{commit}`], repoRoot).trim();
  const harnessCommit = gitOut(['rev-parse', '--verify', 'HEAD^{commit}'], repoRoot).trim();
  const dirty = gitOut(['status', '--porcelain', '--untracked-files=all', '--', HARNESS_REL], repoRoot).trim();
  if (dirty) throw new HarnessError('harness_uncommitted');
  const harnessTree = gitOut(['rev-parse', `${harnessCommit}:${HARNESS_REL}`], repoRoot).trim();
  return { subjectCommit, harnessCommit, harnessTree };
}

function harnessScenarioSet(repoRoot, harnessCommit) {
  const text = gitOut(['show', `${harnessCommit}:${HARNESS_REL}/scenarios.json`], repoRoot);
  return { scenarios: JSON.parse(text), sha256: sha256Text(text) };
}

/** Writes a file that must not already exist. */
function writeOnce(path, content) {
  writeFileSync(path, content, { flag: 'wx' });
}

/** Creates the run's output directory; an existing directory is never reused or overwritten. */
export function createRunDir(outputRoot, runId) {
  mkdirSync(outputRoot, { recursive: true });
  const outDir = join(outputRoot, runId);
  try {
    mkdirSync(outDir);
  } catch {
    throw new HarnessError('output_exists', outDir);
  }
  return outDir;
}

/** The candidate artifact a later phase reuses must be byte-identical to the one its manifest names. */
export function verifyArtifact(artifactFrom) {
  let actual;
  try { actual = sha256File(artifactFrom.file); } catch { throw new HarnessError('artifact_missing'); }
  if (actual !== artifactFrom.sha256) throw new HarnessError('artifact_hash_mismatch');
}

/** Reads the runtime report from a run-owned container of the runtime image; no `docker run --rm` side channel. */
async function readRuntimeReport(docker, resources, imageId) {
  const id = await resources.create('container', (labels) => ['create', ...labels, '--network', 'none', '--log-driver', 'none', '--entrypoint', 'cat', imageId, '/opt/ic/runtime-report.json']);
  try {
    const started = await docker.run(['start', '-a', id], { timeoutMs: 60_000 });
    if (started.code !== 0) throw new HarnessError('runtime_report_missing');
    try { return JSON.parse(started.stdout); } catch { throw new HarnessError('runtime_report_missing'); }
  } finally {
    await resources.remove(id);
  }
}

async function build(docker, resources, { repoRoot, outDir, identities, artifactFrom }) {
  if (artifactFrom) verifyArtifact(artifactFrom);
  const ctx = join(outDir, 'build-context');
  mkdirSync(ctx);
  const archive = (args, file) => {
    const result = spawnSync('git', args, { cwd: repoRoot, maxBuffer: 1024 * 1024 * 1024 });
    if (result.status !== 0) throw new HarnessError('git_archive_failed');
    writeOnce(join(ctx, file), result.stdout);
  };
  archive(['archive', '--format=tar', `${identities.harnessCommit}:${HARNESS_REL}`], 'harness.tar');
  for (const name of ['Dockerfile', '.dockerignore', 'runtime/v1/package.json', 'runtime/v1/package-lock.json', 'runtime/v2/package.json', 'runtime/v2/package-lock.json']) {
    mkdirSync(dirname(join(ctx, name)), { recursive: true });
    writeOnce(join(ctx, name), gitOut(['show', `${identities.harnessCommit}:${HARNESS_REL}/${name}`], repoRoot));
  }
  let artifact;
  if (artifactFrom) {
    copyFileSync(artifactFrom.file, join(ctx, 'plugin.tgz'));
    artifact = { ...artifactFrom, reused: true };
  } else {
    archive(['archive', '--format=tar', identities.subjectCommit], 'subject.tar');
    const dest = join(outDir, 'artifact');
    const built = await docker.run(['build', '--target', 'artifact', '--output', `type=local,dest=${dest}`, ctx], { timeoutMs: 1_800_000 });
    if (built.code !== 0) {
      writeOnce(join(outDir, 'artifact-build.log'), (built.stdout + built.stderr).slice(-20_000));
      throw new HarnessError('artifact_build_failed');
    }
    const report = JSON.parse(readFileSync(join(dest, 'build-report.json'), 'utf8'));
    const file = join(dest, 'oc-arkive.tgz');
    artifact = { file, sha256: sha256File(file), report, reused: false };
    const failures = artifactFailures(report);
    if (failures.length) throw new HarnessError('artifact_checks_failed', failures);
    copyFileSync(file, join(ctx, 'plugin.tgz'));
  }
  const iid = join(outDir, 'runtime.iid');
  const built = await docker.run(['build', '--target', 'runtime', '--build-arg', `PLUGIN_SHA256=${artifact.sha256}`, '--iidfile', iid, ctx], { timeoutMs: 1_800_000 });
  if (built.code !== 0) {
    writeOnce(join(outDir, 'runtime-build.log'), (built.stdout + built.stderr).slice(-20_000));
    throw new HarnessError('runtime_build_failed');
  }
  const imageId = readFileSync(iid, 'utf8').trim();
  return { artifact, runtime: { imageId, ...(await readRuntimeReport(docker, resources, imageId)) } };
}

/** Root-local hive-core resolution, version pins and package exclusions observed in the archived build. */
export function artifactFailures(report) {
  const failures = [];
  if (!report.hiveCoreResolvedInArchive) failures.push('hive_core_not_root_local');
  if (!report.coreBuiltFirst) failures.push('core_not_built_first');
  if ((report.packEntries ?? []).some((p) => /(^|\/)evals\//.test(p))) failures.push('evals_packaged');
  if ((report.packEntries ?? []).some((p) => /(^|\/)(\.env|auth\.json|\.npmrc)$/.test(p))) failures.push('secret_file_packaged');
  if (!(report.packEntries ?? []).includes('dist/index.js')) failures.push('dist_missing');
  return failures;
}

export function runtimeFailures(runtime) {
  const failures = [];
  for (const host of HOST_IDS) {
    const observed = runtime.hosts?.[host]?.version ?? '';
    if (!observed.includes(STOCK_VERSIONS[host])) failures.push(`stock_version_mismatch:${host}`);
  }
  if (!runtime.pluginTarballSha256) failures.push('plugin_tarball_unverified');
  return failures;
}

/** The host-runtime graph a wiring run and the collection built on it must share. */
export function runtimeIdentity(runtime) {
  return {
    hosts: Object.fromEntries(HOST_IDS.map((h) => [h, { version: runtime.hosts[h].version, lockSha256: runtime.hosts[h].lockSha256, graphSha256: runtime.hosts[h].graphSha256, binarySha256: runtime.hosts[h].binarySha256 }])),
    pluginDependencyGraphSha256: runtime.pluginDependencyGraphSha256,
    node: runtime.node,
    git: runtime.git,
    baseImage: runtime.baseImage,
  };
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

/** Selects the frozen model: the first preference that both exact host catalogs list as tool-capable. */
export function selectSharedModel(preference, catalogs) {
  for (const id of preference) {
    if (Object.values(catalogs).every((models) => models.some((m) => m.id === id && m.toolCall))) return id;
  }
  return null;
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

async function wiringHost(ctx, host) {
  const id = await openContainer(ctx, { network: 'none', ceilingSeconds: CEILING.wiring });
  try {
    // Stock permissions: no permissive allow rule. The override fixture supplies a same-name user skill.
    await step(ctx, id, 'serve', { host, provider: 'mock', model: ctx.scenarios.model.mock, agentMode: 'dedicated', scenario: 'skill-override-reference', permissive: false });
    return (await step(ctx, id, 'wiring', { host }, { timeoutMs: 2_700_000 })).wiring;
  } finally {
    await ctx.resources.remove(id);
  }
}

/** Wiring requirements on each host's observation, plus cross-host parity of the direct tool parameters. */
export function wiringFailures(results) {
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
    if (!command.bodyDelivered) failures.push(`command_body_not_delivered:${host}:${command.command ?? 'unknown'}`);
    if (!command.skillLoaded) failures.push(`command_consumer_skill_not_loaded:${host}`);
    for (const row of command.referenceReads ?? []) if (!row.readCompleted) failures.push(`command_consumer_reference_failed:${host}:${row.file}`);
    if (!w.override?.listed) failures.push(`override_not_listed:${host}`);
    if (!w.override?.resolvesToUserSkill) failures.push(`override_not_user_skill:${host}`);
    if (!w.override?.loadedUserBody) failures.push(`override_body_not_loaded:${host}`);
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
    for (const host of options.hosts) results[host] = await wiringHost(ctx, host);
    writeOnce(join(outDir, 'wiring.json'), JSON.stringify(results, null, 2));
    manifest.wiring = { file: 'wiring.json', sha256: sha256File(join(outDir, 'wiring.json')) };
    manifest.failures = wiringFailures(results).map((code) => ({ code }));
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
    if (!id) throw new HarnessError('no_shared_model');
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
