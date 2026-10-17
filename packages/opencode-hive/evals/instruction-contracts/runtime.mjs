// Scenario-independent host controls shared by every host-side driver in this directory: the Docker engine boundary,
// exact-ID resource ownership and its ledger, immutable run records, archive/artifact/runtime identity and builds, and
// container isolation arguments and probe validation. No scenario, credential or CLI policy lives here; those stay with
// run.mjs, credentials.mjs, guard.mjs and hosts.mjs.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync,
  statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { release } from 'node:os';
import { dirname, join } from 'node:path';
import { GUARD_UID } from './guard.mjs';
import { HOST_IDS } from './hosts.mjs';

export const HARNESS_REL = 'packages/opencode-hive/evals/instruction-contracts';
export const GUARD = '/opt/ic/harness/guard.mjs';
export const AGENT_USER = '1000:1000';
export const GUARD_USER = `${GUARD_UID}:${GUARD_UID}`;

// Bounded RAM for every scenario container, equal to its memory+swap limit so no container page can swap.
const CONTAINER_MEMORY = '4g';
const CONTAINER_MEMORY_BYTES = 4 * 1024 ** 3;
const STOCK_VERSIONS = { v1: '1.18.30', v2: '2.0.26' };
export const ISOLATION = Object.freeze({
  memory: CONTAINER_MEMORY, memorySwap: CONTAINER_MEMORY, logDriver: 'none', coreLimit: '1:1', corePatterns: ['pipe', 'file'],
  rootfs: 'read-only', tmpfs: ['/work', '/tmp'], agentUser: AGENT_USER, guardUser: GUARD_USER, init: 'docker-init',
});

export class HarnessError extends Error {
  constructor(code, detail) {
    super(`instruction-contracts: ${code}`);
    this.code = code;
    this.detail = detail;
  }
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

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function gitOut(args, cwd) {
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

/** Writes a file that must not already exist. */
export function writeOnce(path, content) {
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

export async function build(docker, resources, { repoRoot, outDir, identities, artifactFrom }) {
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
