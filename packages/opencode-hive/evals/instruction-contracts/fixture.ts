// In-container fixture runtime. Runs only inside a disposable scenario container (Node type stripping), never on the
// operator host. Each command prints exactly one JSON line on stdout; run.mjs parses that line and nothing else.
// Credential values may exist only in this container's tmpfs; `export` scans its own output before returning it.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  HIVE_COMMANDS, HIVE_ROLES, REFRESH_SENTINEL, fieldContractFindings, hiveConfig, hostConfig, hostSpec, nativeToolCall,
  neutralArgs, neutralTool, runArgs, serveArgs, sessionCreateRequest,
} from './hosts.mjs';

const HARNESS = dirname(new URL(import.meta.url).pathname);
const WORK = '/work';
const PROJ = '/work/proj';
const HOME = '/work/home';
const STATE = '/work/state';
const SERVER_PORT = 4096;
const MOCK_PORT = 4097;
const SCENARIOS = JSON.parse(readFileSync(join(HARNESS, 'scenarios.json'), 'utf8'));

type Json = any;

function emit(value: Json): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function fail(code: string, detail?: Json): never {
  emit({ ok: false, failure: code, ...(detail === undefined ? {} : { detail }) });
  process.exit(3);
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function readJson(path: string, fallback: Json = null): Json {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function group(id: string): Json {
  const found = SCENARIOS.groups.find((g: Json) => g.id === id);
  if (!found) fail('unknown_scenario', id);
  return found;
}

function git(args: string[], cwd = PROJ): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------------------------------------------
// Template facts. `{{name}}` renders a setup fact; prefixed tokens resolve from the filesystem. Tokens that cannot
// be resolved yet (for example a worktree a scripted step creates later) stay intact for the mock to resolve.

function featureDir(name: string): string | null {
  const root = join(PROJ, '.hive', 'features');
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root)) {
    if (readJson(join(root, entry, 'feature.json'))?.name === name) return join('.hive', 'features', entry);
  }
  return null;
}

function findDir(root: string, leaf: string, depth = 3): string | null {
  if (!existsSync(root) || depth < 0) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (entry.name === leaf) return path;
    const nested = findDir(path, leaf, depth - 1);
    if (nested) return nested;
  }
  return null;
}

function resolveToken(token: string, facts: Json): string | null {
  if (token in facts) {
    const value = facts[token];
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  const [kind, ...rest] = token.split(':');
  if (kind === 'featureDir') return featureDir(rest[0]);
  if (kind === 'worktreeOf') return findDir(join(PROJ, '.hive', '.worktrees'), rest[1]);
  if (kind === 'adhocWorktree') return findDir(join(PROJ, '.hive', '.worktrees'), rest[0]);
  // Deterministic filler, for documents that must span several read chunks.
  if (kind === 'fill') return Array.from({ length: Number(rest[0]) }, (_, i) => `- Note ${i + 1}: release notes stay short, factual and dated.`).join('\n');
  return null;
}

// A token may contain regex quantifiers such as {40}, so single-brace groups of digits are allowed inside it.
const TEMPLATE_TOKEN = /\{\{((?:[^{}]|\{\d+(?:,\d*)?\})+?)\}\}/g;

export function render(value: Json, facts: Json, resolver = resolveToken): Json {
  if (typeof value === 'string') {
    return value.replace(TEMPLATE_TOKEN, (whole, token) => resolver(token, facts) ?? whole);
  }
  if (Array.isArray(value)) return value.map((item) => render(item, facts, resolver));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, facts, resolver)]));
  }
  return value;
}

function currentFacts(): Json {
  return readJson(join(STATE, 'facts.json'), {});
}

export function scriptDirective(script: Json[]): string {
  return `[[script:${Buffer.from(JSON.stringify(script)).toString('base64')}]]`;
}

// ---------------------------------------------------------------------------------------------------------------
// Scripted mock provider. OpenAI-compatible chat completions on loopback; it follows `[[script:...]]` directives
// carried in the latest scripted user message and emits one native tool call or text per assistant turn. It proves
// wiring and fixture feasibility only. It implements no Hive policy.

function textOf(content: Json): string {
  if (typeof content === 'string') return content;
  return (content ?? []).map((part: Json) => part?.text ?? '').join('');
}

export function decodeScript(text: string): Json[] | null {
  const matches = [...text.matchAll(/\[\[script:([A-Za-z0-9+/=]+)\]\]/g)];
  if (matches.length === 0) return null;
  return JSON.parse(Buffer.from(matches[matches.length - 1][1], 'base64').toString('utf8'));
}

function getPath(value: Json, path: string): Json {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), value);
}

function parseToolOutput(text: string): Json {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && typeof value.result === 'string') {
      try { return JSON.parse(value.result); } catch { return value; }
    }
    return value;
  } catch {
    const start = text.indexOf('{');
    if (start >= 0) {
      try { return JSON.parse(text.slice(start)); } catch { /* fall through */ }
    }
    return null;
  }
}

/** Decides the next scripted assistant turn from an OpenAI-style request body. */
export function mockDecision(host: string, body: Json): Json {
  const messages = body.messages ?? [];
  const tools: string[] = (body.tools ?? []).map((t: Json) => t.function?.name).filter(Boolean);
  if (tools.length === 0) return { text: 'Fixture title' };
  let scriptedIndex = -1;
  let script: Json[] | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    const decoded = decodeScript(textOf(messages[i].content));
    if (decoded) { scriptedIndex = i; script = decoded; break; }
  }
  if (!script) return { text: 'ok' };
  const after = messages.slice(scriptedIndex + 1);
  const step = after.filter((m: Json) => m.role === 'assistant').length;
  if (step >= script.length) return { text: 'Script complete.' };
  const callNames = new Map<string, string>();
  for (const m of after) for (const call of m.tool_calls ?? []) callNames.set(call.id, call.function?.name);
  const results = after.filter((m: Json) => m.role === 'tool').map((m: Json) => ({ tool: callNames.get(m.tool_call_id) ?? '', text: textOf(m.content) }));
  const lazy = (token: string): string | null => {
    // {{match:REGEX}} searches every earlier result, newest first; {{matchIn:TOOL:REGEX}} only one tool's results.
    const scoped = /^matchIn:([a-z_]+):/.exec(token);
    if (token.startsWith('match:') || scoped) {
      const pattern = new RegExp(scoped ? token.slice(scoped[0].length) : token.slice('match:'.length));
      for (const result of [...results].reverse()) {
        if (scoped && neutralTool(result.tool) !== scoped[1]) continue;
        const found = result.text.match(pattern);
        if (found) return found[1] ?? found[0];
      }
      return null;
    }
    if (token.startsWith('skillDir:')) {
      const name = token.slice('skillDir:'.length);
      const pattern = new RegExp(`(/[^\\s"'<>]*/${name})(?=[\\s"'/<>]|$)`);
      for (const result of [...results].reverse()) {
        const found = result.text.match(pattern);
        if (found) return found[1];
      }
      return null;
    }
    return resolveToken(token, currentFacts());
  };
  const resolveObjects = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(resolveObjects);
    if (value && typeof value === 'object') {
      if (value.$result) {
        const wanted = value.$result.tool;
        for (const result of [...results].reverse()) {
          const parsed = parseToolOutput(result.text);
          if ((result.tool === wanted || result.tool === 'execute') && parsed) {
            const found = getPath(parsed, value.$result.path);
            if (found !== undefined) return found;
          }
        }
        return null;
      }
      // Child scripts keep their `$result` markers: they resolve against the child's own tool results.
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'script' ? v : resolveObjects(v)]));
    }
    return value;
  };
  const current = resolveObjects(render(script[step], {}, lazy));
  // `json` is a text step whose body is one JSON document written as data, so scripted reports stay readable.
  if (current.op === 'text') return { text: current.json === undefined ? current.text : JSON.stringify(current.json) };
  if (current.op === 'dispatch') current.prompt = `${current.prompt}\n${scriptDirective(current.script ?? [])}`;
  return { call: nativeToolCall(host, current, tools) };
}

function serveMock(host: string): void {
  let seq = 0;
  createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"object":"list","data":[]}');
        return;
      }
      const body = JSON.parse(raw);
      const decision = mockDecision(host, body);
      const id = ++seq;
      const system = (body.messages ?? []).filter((m: Json) => m.role === 'system').map((m: Json) => textOf(m.content)).join('\n');
      appendFileSync(join(STATE, 'requests.jsonl'), JSON.stringify({
        id, model: body.model, system, tools: body.tools ?? [], lastUser: textOf((body.messages ?? []).findLast((m: Json) => m.role === 'user')?.content).slice(0, 4000),
        decision,
      }) + '\n');
      const base = { id: `mock-${id}`, object: 'chat.completion.chunk', created: 0, model: body.model };
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: base.id, object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: decision.text ?? '' }, finish_reason: 'stop' }], usage }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = decision.call
        ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${id}`, type: 'function', function: { name: decision.call.tool, arguments: JSON.stringify(decision.call.args) } }] }
        : { role: 'assistant', content: decision.text };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: decision.call ? 'tool_calls' : 'stop' }], usage })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  }).listen(MOCK_PORT, '127.0.0.1');
}

// ---------------------------------------------------------------------------------------------------------------
// Host server lifecycle and native API access.

function authHeader(): string {
  return 'Basic ' + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64');
}

async function api(path: string, init: Json = {}): Promise<Json> {
  const response = await fetch(`http://127.0.0.1:${SERVER_PORT}${path}`, {
    ...init,
    headers: { authorization: authHeader(), 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body: Json = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: response.status, ok: response.ok, body };
}

function unwrap(body: Json): Json {
  return body && typeof body === 'object' && !Array.isArray(body) && 'data' in body ? body.data : body;
}

async function waitReady(host: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if ((await api(hostSpec(host).readyPath, { signal: AbortSignal.timeout(5_000) })).ok) return true;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function detach(command: string, args: string[], logName: string, env: Json = {}): number {
  mkdirSync(join(WORK, 'logs'), { recursive: true });
  const out = join(WORK, 'logs', logName);
  const child = spawn(command, args, {
    cwd: PROJ, detached: true, env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
  writeFileSync(out + '.pid', String(child.pid));
  return child.pid ?? -1;
}

/**
 * The home files and user skills a scenario installs. `fixture.caseOverrides` holds the files only scenario cases and
 * their rehearsal install; wiring skips them so the packaged skills it reads references from stay the active ones.
 */
export function scenarioOverrides(scenario: Json | null, wiring: boolean): { homeFiles: Json; userSkills: Json } {
  const caseOverrides = wiring ? {} : scenario?.fixture?.caseOverrides ?? {};
  return {
    homeFiles: { ...(scenario?.fixture?.homeFiles ?? {}), ...(caseOverrides.homeFiles ?? {}) },
    userSkills: { ...(scenario?.fixture?.userSkills ?? {}), ...(caseOverrides.userSkills ?? {}) },
  };
}

function prepareHome(scenario: Json | null, wiring = false): string | null {
  mkdirSync(join(HOME, '.config', 'opencode'), { recursive: true });
  const { homeFiles, userSkills } = scenarioOverrides(scenario, wiring);
  for (const [path, content] of Object.entries(homeFiles)) writeFile(join(HOME, path), content as string);
  if (Object.keys(userSkills).length === 0) return null;
  const dir = join(WORK, 'user-skills');
  for (const [path, content] of Object.entries(userSkills)) writeFile(join(dir, path), content as string);
  return dir;
}

async function serve(input: Json): Promise<Json> {
  const { host, provider, model, variant, agentMode, scenario, permissive, wiring } = input;
  mkdirSync(STATE, { recursive: true });
  mkdirSync(PROJ, { recursive: true });
  const userSkillsDir = prepareHome(scenario ? group(scenario) : null, wiring === true);
  const config = hostConfig(host, { provider, model, mockPort: MOCK_PORT, serverPort: SERVER_PORT, userSkillsDir, observer: join(HARNESS, 'observer'), permissive });
  writeFile(join(PROJ, hostSpec(host).configFile), JSON.stringify(config, null, 2));
  writeFile(join(HOME, '.config', 'opencode', 'agent_hive.json'), JSON.stringify(hiveConfig({ provider, model, variant, agentMode }), null, 2));
  if (provider === 'mock' && !existsSync(join(STATE, 'mock.pid'))) {
    const pid = detach(process.execPath, [new URL(import.meta.url).pathname, 'mock-provider', JSON.stringify({ host })], 'mock.log');
    writeFileSync(join(STATE, 'mock.pid'), String(pid));
  }
  const started = Date.now();
  const pid = detach('/bin/sh', ['-c', `exec "$0" "$@" >> ${WORK}/logs/serve-${host}.log 2>&1`, hostSpec(host).binary, ...serveArgs(host, SERVER_PORT)], `serve-${host}`,
    provider === 'mock' ? { MOCK_PROVIDER_KEY: 'mock-not-a-secret' } : {});
  writeFileSync(join(STATE, 'server.pid'), String(pid));
  const ready = await waitReady(host, 120_000);
  if (!ready) fail('host_not_ready');
  return { ok: true, startupMs: Date.now() - started };
}

async function listening(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${SERVER_PORT}/`, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

/** Stops the host server and waits until its port is closed, so the next server cannot be confused with it. */
async function stopServer(): Promise<Json> {
  const pidFile = join(STATE, 'server.pid');
  if (!existsSync(pidFile)) return { ok: true, stopped: false };
  const pid = Number(readFileSync(pidFile, 'utf8'));
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try { process.kill(-pid, signal); } catch { /* already gone */ }
    for (let i = 0; i < 40 && await listening(); i++) await new Promise((r) => setTimeout(r, 500));
    if (!await listening()) break;
  }
  if (await listening()) fail('host_not_stopped');
  writeFileSync(pidFile + '.stopped', String(pid));
  spawnSync('rm', ['-f', pidFile]);
  return { ok: true, stopped: true };
}

/** Runs one headless primary prompt. Pending questions or permission requests end the run as an operator stop. */
export async function runPrompt(host: string, { agent, modelRef, prompt, command }: Json, timeoutMs: number): Promise<Json> {
  const create = sessionCreateRequest(host, { agent, directory: PROJ });
  const created = await api(create.path, { method: 'POST', body: JSON.stringify(create.body) });
  const sessionId = unwrap(created.body)?.id ?? null;
  if (!sessionId) return { exit: -1, sessionId: null, events: [], asked: null, timedOut: false, durationMs: 0 };
  const started = Date.now();
  let exited: Promise<number>;
  let stop: () => void;
  if (command && host === 'v2') {
    // The v2 CLI has no command flag; the public session command route is the native consumer.
    const abort = new AbortController();
    stop = () => abort.abort();
    exited = (async () => {
      try {
        const sent = await api(`/api/session/${sessionId}/command`, { method: 'POST', body: JSON.stringify({ name: command, text: prompt }), signal: abort.signal });
        if (!sent.ok) return -1;
        // An HTTP failure is a response, not an exception: only an acknowledged wait shows the session reached idle.
        const waited = await api(`/api/experimental/session/${sessionId}/wait`, { method: 'POST', signal: abort.signal });
        return waited.ok ? 0 : -1;
      } catch {
        return -1;
      }
    })();
  } else {
    // Native CLI output is not evidence; history is read back through the server API after the run.
    const child = spawn(hostSpec(host).binary, runArgs(host, { port: SERVER_PORT, session: sessionId, agent, modelRef, prompt, command }), {
      cwd: PROJ, env: { ...process.env, OPENCODE_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD }, stdio: ['ignore', 'ignore', 'ignore'],
    });
    stop = () => child.kill('SIGTERM');
    exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)));
  }
  let asked: Json = null;
  let timedOut = false;
  const questions: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const done = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 2000))]);
    if (done !== null) break;
    const pending = await pendingInteraction(host);
    // Headless v2 rejects a question tool call and the session continues. v1 waits for an answer, so the driver
    // rejects it the same way to keep both hosts comparable; the question stays in the exported tool calls.
    if (pending?.kind === 'question' && host === 'v1') {
      await api(`/question/${pending.id}/reject`, { method: 'POST', body: '{}' });
      questions.push(pending.id);
      continue;
    }
    asked = pending;
    if (asked || Date.now() > deadline) {
      timedOut = !asked;
      stop();
      await exited;
      break;
    }
  }
  const exit = await exited;
  return { exit, sessionId, asked, questionsRejected: questions.length, timedOut, durationMs: Date.now() - started };
}

/** Stops the native session behind a run that did not finish. Ending the driver's process or request leaves that session running. */
export async function interruptSession(host: string, sessionId: string): Promise<boolean> {
  const res = await (host === 'v1' ? api(`/session/${sessionId}/abort`, { method: 'POST' }) : api(`/api/session/${sessionId}/interrupt`, { method: 'POST' }));
  return res.ok;
}

async function pendingInteraction(host: string): Promise<Json> {
  const paths = host === 'v1' ? ['/question', '/permission'] : ['/api/form', '/api/permission/request'];
  for (const path of paths) {
    try {
      const { ok, body } = await api(path);
      const items = unwrap(body);
      if (ok && Array.isArray(items) && items.length > 0) {
        return { kind: path.includes('permission') ? 'permission' : 'question', id: items[0].id, count: items.length };
      }
    } catch { /* endpoint unavailable */ }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Fixture setup. Hive state is created through the installed plugin's own tools, driven one call at a time by the
// scripted mock, so the state is exactly what the subject plugin writes.

async function hiveCall(host: string, tool: string, args: Json, agent = 'hive-builder'): Promise<Json> {
  const prompt = `fixture setup\n${scriptDirective([{ op: 'hive', tool, args }, { op: 'text', text: 'done' }])}`;
  const run = await runPrompt(host, { agent, modelRef: `mock/${SCENARIOS.model.mock}`, prompt }, 120_000);
  if (!run.sessionId) return { status: 'no_session', output: '', parsed: null };
  const calls = (await messages(host, run.sessionId)).flatMap((m) => m.tools).filter((t: Json) => t.name === tool || t.name === 'execute');
  const call = calls[calls.length - 1];
  const raw = call?.output ?? '';
  const output = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return { status: call?.status ?? 'missing', output, parsed: parseToolOutput(output) };
}

/** A Hive tool result that reports failure in any of its documented outcome shapes. */
export function hiveResultFailed(parsed: Json): boolean {
  if (!parsed || typeof parsed !== 'object') return true;
  if (parsed.success === false || parsed.error || parsed.ok === false) return true;
  for (const key of ['approval', 'sync']) if (parsed[key] && parsed[key].success === false) return true;
  return false;
}

function factValue(spec: Json, facts: Json): Json {
  if (spec.git) return git(render(spec.git, facts), render(spec.dir ?? PROJ, facts));
  if (spec.sha256) {
    const dir = render(spec.dir ?? PROJ, facts);
    return sha256(readFileSync(join(dir, render(spec.sha256, facts))));
  }
  if (spec.from) return getPath(facts[spec.from], spec.path);
  throw new Error('unknown fact spec');
}

async function setup(input: Json): Promise<Json> {
  const { host } = input;
  const scenario = group(input.scenario);
  const files = { ...SCENARIOS.baseRepo, ...(scenario.fixture.files ?? {}) };
  for (const [path, content] of Object.entries(files)) writeFile(join(PROJ, path), content as string);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'user.name', 'Fixture']);
  git(['add', '-A']);
  git(['commit', '-qm', 'chore: fixture base', '-m', 'Miniature evaluation repository.']);
  const facts: Json = { baseCommit: git(['rev-parse', 'HEAD']) };
  const steps: Json[] = [];
  for (const raw of scenario.fixture.setup ?? []) {
    // The mock reads facts from this file, so scripted setup sessions see every earlier capture.
    writeFile(join(STATE, 'facts.json'), JSON.stringify(facts));
    const step = render(raw, facts);
    if (step.do === 'files') {
      const dir = step.dir ? (step.dir.startsWith('/') ? step.dir : join(PROJ, step.dir)) : PROJ;
      for (const [path, content] of Object.entries(step.files)) writeFile(join(dir, path), content as string);
    } else if (step.do === 'commit') {
      git(['add', '-A']);
      git(['commit', '-qm', step.message, '-m', 'Fixture commit.']);
      if (step.capture) facts[step.capture] = git(['rev-parse', 'HEAD']);
    } else if (step.do === 'hive') {
      const result = await hiveCall(host, step.tool, step.args);
      const ok = result.status === 'completed' && !hiveResultFailed(result.parsed);
      steps.push({ do: 'hive', tool: step.tool, ok, status: result.status });
      if (!ok) fail('fixture_step_failed', { tool: step.tool, status: result.status, output: result.output.slice(0, 1200) });
      for (const [name, path] of Object.entries(step.capture ?? {})) {
        const value = getPath(result.parsed, path as string);
        if (value === undefined) fail('fixture_capture_missing', { tool: step.tool, capture: name, keys: Object.keys(result.parsed ?? {}) });
        facts[name] = value;
      }
      continue;
    } else if (step.do === 'session') {
      const run = await runPrompt(host, { agent: step.agent, modelRef: `mock/${SCENARIOS.model.mock}`, prompt: `fixture session\n${scriptDirective(step.script)}` }, 180_000);
      if (!run.sessionId) fail('fixture_session_missing');
      facts[step.capture] = run.sessionId;
      const tree = await sessionTree(host, run.sessionId);
      const child = tree.find((s: Json) => s.id !== run.sessionId);
      if (!child) fail('fixture_child_missing');
      facts[`${step.capture}Child`] = child.id;
    } else if (step.do === 'facts') {
      for (const [name, spec] of Object.entries(step.facts)) facts[name] = factValue(spec, facts);
    } else {
      fail('unknown_setup_step', step.do);
    }
    steps.push({ do: step.do, ok: true });
  }
  writeFile(join(STATE, 'facts.json'), JSON.stringify(facts));
  return { ok: true, facts, steps, prompt: render(scenario.prompt, facts) };
}

// ---------------------------------------------------------------------------------------------------------------
// Native history normalization. Both hosts are read through their own HTTP APIs inside the container.

async function listSessions(host: string): Promise<Json[]> {
  const res = host === 'v1'
    ? await api(`/session?directory=${encodeURIComponent(PROJ)}`)
    : await api(`/api/session?directory=${encodeURIComponent(PROJ)}&limit=200`);
  const items = unwrap(res.body);
  return Array.isArray(items) ? items : [];
}

function hiveParents(): Map<string, string> {
  const parents = new Map<string, string>();
  for (const file of ['.hive/sessions.json', '.hive/runtime/opencode-v2/sessions.json']) {
    for (const s of readJson(join(PROJ, file), { sessions: [] })?.sessions ?? []) {
      if (s.sessionId && s.parentSessionId) parents.set(s.sessionId, s.parentSessionId);
    }
  }
  return parents;
}

async function sessionTree(host: string, rootId: string): Promise<Json[]> {
  const sessions = await listSessions(host);
  const hive = hiveParents();
  const parentOf = (s: Json) => s.parentID ?? s.parentId ?? s.parent?.id ?? hive.get(s.id) ?? null;
  const tree = sessions.filter((s) => s.id === rootId);
  let frontier = [rootId];
  while (frontier.length) {
    const next = sessions.filter((s) => frontier.includes(parentOf(s)) && !tree.some((t) => t.id === s.id));
    tree.push(...next);
    frontier = next.map((s) => s.id);
  }
  return tree.map((s) => ({ id: s.id, parentId: parentOf(s), agent: s.agent ?? null }));
}

/** A fixed-vocabulary name (error class, failure code) that is safe to export; anything else becomes 'other'. */
export function safeName(value: Json): string | null {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(value) ? value : 'other';
}

export type HistoryRead = { history: Json[]; complete: boolean; failure: 'history_request_failed' | 'history_body_malformed' | null };

/**
 * A session's messages, and what was read of them. `failure` names a read that did not return a valid page (an HTTP
 * error, an unreachable server, a body of the wrong shape); the messages before it are kept but are not the whole
 * history. `complete: false` with no failure means the page cap ended a history the host still had more of.
 */
export async function messagePages(host: string, sessionId: string, get: (path: string) => Promise<Json> = api): Promise<HistoryRead> {
  const read = async (path: string): Promise<Json> => { try { return await get(path); } catch { return null; } };
  const isPage = (items: Json) => Array.isArray(items) && items.every((m) => m && typeof m === 'object');
  if (host === 'v1') {
    const res = await read(`/session/${sessionId}/message`);
    if (!res?.ok) return { history: [], complete: false, failure: 'history_request_failed' };
    if (!isPage(res.body)) return { history: [], complete: false, failure: 'history_body_malformed' };
    const history = res.body.map((m: Json) => ({
      role: m.info?.role,
      agent: m.info?.agent ?? m.info?.mode ?? null,
      model: m.info?.role === 'assistant' ? { providerID: m.info?.providerID ?? null, modelID: m.info?.modelID ?? null, variant: m.info?.variant ?? null } : null,
      tokens: m.info?.tokens ?? null,
      error: m.info?.error ? safeName(m.info.error.name) ?? 'other' : null,
      text: (m.parts ?? []).filter((p: Json) => p.type === 'text').map((p: Json) => p.text).join(''),
      tools: (m.parts ?? []).filter((p: Json) => p.type === 'tool').map((p: Json) => ({
        name: p.tool, status: p.state?.status, input: p.state?.input, metadata: p.state?.metadata ?? null,
        output: p.state?.output ?? p.state?.error, errorName: p.state?.status === 'error' ? 'tool_error' : null,
      })),
    }));
    return { history, complete: true, failure: null };
  }
  const out: Json[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await read(`/api/session/${sessionId}/message?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : '&order=asc'}`);
    if (!res?.ok) return { history: out, complete: false, failure: 'history_request_failed' };
    const items = unwrap(res.body);
    const next = res.body?.cursor?.next;
    if (!isPage(items) || (next !== undefined && next !== null && typeof next !== 'string')) return { history: out, complete: false, failure: 'history_body_malformed' };
    for (const m of items) {
      out.push({
        role: m.type === 'assistant' ? 'assistant' : m.type,
        agent: m.agent ?? null,
        model: m.type === 'assistant' ? { providerID: m.model?.providerID ?? null, modelID: m.model?.id ?? null, variant: m.model?.variant ?? null } : null,
        tokens: m.tokens ?? null,
        retries: m.retry ? 1 : 0,
        error: m.error ? safeName(m.error.type ?? m.error._tag ?? m.error.name) ?? 'other' : null,
        // A v2 user message carries its prompt as `text`; assistant messages carry text parts in `content`.
        text: m.type === 'user' && typeof m.text === 'string' ? m.text : (m.content ?? []).filter((p: Json) => p.type === 'text').map((p: Json) => p.text).join(''),
        tools: (m.content ?? []).filter((p: Json) => p.type === 'tool').map((p: Json) => ({
          name: p.name, status: p.state?.status, input: p.state?.input, metadata: p.state?.metadata ?? null,
          output: p.state?.output ?? (Array.isArray(p.state?.content) ? p.state.content.map((c: Json) => c.text ?? '').join('') : undefined) ?? '',
          errorName: p.state?.status === 'error' ? safeName(p.state?.error?.type ?? p.state?.error?._tag ?? p.state?.error?.name) ?? 'tool_error' : null,
        })),
      });
    }
    cursor = next || undefined;
    if (!cursor) break;
  }
  return { history: out, complete: !cursor, failure: null };
}

/** Setup and wiring read messages only to find what a scripted call returned; an unread history leaves the call missing, which fails their own checks. */
async function messages(host: string, sessionId: string): Promise<Json[]> {
  return (await messagePages(host, sessionId)).history;
}

/** Every session's history, with the sessions whose read the page cap cut short and those whose read failed. */
export async function readHistories(host: string, tree: Json[], get?: (path: string) => Promise<Json>) {
  const histories = new Map<string, Json[]>();
  const historyIncomplete: string[] = [];
  const historyFailed: { session: string; code: string }[] = [];
  for (const node of tree) {
    const read = await messagePages(host, node.id, get);
    histories.set(node.id, read.history);
    if (read.failure) historyFailed.push({ session: node.id, code: read.failure });
    else if (!read.complete) historyIncomplete.push(node.id);
  }
  return { histories, historyIncomplete, historyFailed };
}

const LARGE_ARGS = new Set(['report', 'handoff', 'content', 'prompt', 'summary', 'message']);

/**
 * Keeps only the argument fields an assessor reads, bounded, and names the fields the bound cut short. Fields of an
 * argument the allowlist does not carry at all are not listed: the record never claims to show them. Tool outputs are
 * never exported.
 */
export function clipToolArgs(name: string, input: Json): { args: Json; truncated: string[] } {
  const neutral = neutralArgs(name, input);
  const tool = neutralTool(name);
  const truncated: string[] = [];
  const clip = (field: string, value: Json, size: number) => {
    if (typeof value !== 'string' || value.length <= size) return value;
    truncated.push(field);
    return value.slice(0, size);
  };
  const done = (args: Json) => ({ args, truncated });
  if (tool === 'dispatch') return done({ agent: neutral.agent, description: clip('description', neutral.description, 200), prompt: clip('prompt', neutral.prompt, 4000), background: neutral.background });
  if (tool === 'read' || tool === 'write' || tool === 'edit') return done({ path: clip('path', neutral.path, 500) });
  if (tool === 'skill') return done({ name: neutral.name });
  if (tool === 'question') return done({ question: clip('question', input?.questions?.[0]?.question, 500) });
  if (tool === 'shell') return done({ command: clip('command', input?.command, 1000) });
  if (tool === 'execute') return done({ code: clip('code', input?.code, 1000) });
  if (tool === 'grep' || tool === 'glob') return done({ pattern: clip('pattern', input?.pattern, 300), path: clip('path', input?.path, 300) });
  if (tool.startsWith('hive_')) {
    const out: Json = {};
    for (const [key, value] of Object.entries(input ?? {})) {
      if (typeof value === 'string') out[key] = clip(key, value, LARGE_ARGS.has(key) ? 1000 : 300);
      else if (typeof value === 'boolean' || typeof value === 'number' || value === null) out[key] = value;
      else out[key] = clip(key, JSON.stringify(value), 500);
    }
    return done(out);
  }
  return done({});
}

export function allowlistArgs(name: string, input: Json): Json {
  return clipToolArgs(name, input).args;
}

/** Text bounded to `cap` characters, with whether the bound cut it and its original length. */
export function clipText(text: string, cap: number): { text: string; truncated: boolean; chars: number } {
  return { text: text.slice(0, cap), truncated: text.length > cap, chars: text.length };
}

/**
 * Sanitized outcome of one native tool call, derived inside the container from the call's own state. Scenario checks use
 * this instead of the attempt: `result` is 'success', 'failure' or 'unknown'. Only fixed-vocabulary codes, exit codes
 * and session identities leave the container; tool outputs never do. A Code Mode `execute` call is recorded as itself:
 * the code it submitted is not evidence of which Hive operations ran or succeeded.
 */
export function toolOutcome(call: Json, session: Json, tree: Json[]): Json {
  const tool = neutralTool(call.name);
  const metadata = call.metadata && typeof call.metadata === 'object' ? call.metadata : {};
  const output = typeof call.output === 'string' ? call.output : JSON.stringify(call.output ?? '');
  if (call.status !== 'completed') return { result: call.status === 'error' ? 'failure' : 'unknown', code: call.errorName ?? safeName(call.status) };
  if (tool === 'dispatch') {
    const fromOutput = /(?:task id|sessionID)="(ses_[A-Za-z0-9]+)"/.exec(output)?.[1] ?? null;
    const childSessionId = metadata.sessionId ?? metadata.sessionID ?? fromOutput;
    const child = tree.find((s) => s.id === childSessionId);
    const requested = neutralArgs(call.name, call.input).agent;
    const failed = metadata.status !== undefined && metadata.status !== 'completed';
    const verified = Boolean(child) && child.parentId === session.id && child.agent === requested && child.assistantMessages > 0 && child.errors === 0;
    return { result: failed ? 'failure' : verified ? 'success' : 'unknown', childSessionId: childSessionId ?? null, childAgent: child?.agent ?? null };
  }
  if (tool.startsWith('hive_')) {
    const parsed = parseToolOutput(output);
    if (parsed === null) return { result: 'unknown', code: 'unparsed_result' };
    const failed = hiveResultFailed(parsed);
    const code = safeName(parsed.error?.code ?? parsed.code ?? parsed.reason ?? parsed.failure ?? parsed.sync?.reason ?? (typeof parsed.error === 'string' ? parsed.error : undefined));
    return { result: failed ? 'failure' : 'success', ...(code ? { code } : {}) };
  }
  if (tool === 'shell') {
    const exitCode = Number.isInteger(metadata.exit) ? metadata.exit : null;
    return { result: exitCode === null ? 'unknown' : exitCode === 0 ? 'success' : 'failure', exitCode };
  }
  if (tool === 'skill') {
    const source = /\/work\/user-skills\//.test(output) ? 'user' : /agent-hive\/generated\/opencode-skills\//.test(output) ? 'generated' : 'other';
    return { result: 'success', source };
  }
  return { result: 'success' };
}

/** Model requests the read-only observer recorded for the given sessions, already reduced to identities and settings. */
const REQUEST_CAP = 2000;
function observedRequests(sessionIds: Set<string>): { requests: Json[]; truncated: boolean } {
  const path = join(STATE, 'observer.jsonl');
  if (!existsSync(path)) return { requests: [], truncated: false };
  const all = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { malformed: true }; }
  }).filter((r) => r.malformed || sessionIds.has(r.sessionID));
  return { requests: all.slice(0, REQUEST_CAP), truncated: all.length > REQUEST_CAP };
}

/**
 * Retained remote attempts counted at the fixture's own test boundary: the fixture test appends one line to this log
 * every time the file starts, whichever command ran it (a targeted run, `node --test`, `npm test`). The log is seeded
 * with a header and the earlier attempts, so a deleted, truncated or rewritten log is invalid evidence, never zero
 * attempts. Grader probes set IC_GRADER and are not counted.
 */
export const ATTEMPT_LOG_HEADER = 'ic-remote-attempts v1';
export function attemptCount(text: string | null): number | Json {
  if (text === null) return { error: 'attempt_log_missing' };
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== ATTEMPT_LOG_HEADER || !lines.slice(1).every((line) => /^\d+ \d+$/.test(line))) return { error: 'attempt_log_invalid' };
  return lines.length - 1;
}

/** A stdout probe keeps this many characters; one more is read so a longer output can be reported as cut. */
const PROBE_STDOUT_CAP = 2000;

function runProbe(probe: Json, facts: Json, run: Json = {}): Json {
  const dir = render(probe.dir ?? PROJ, facts);
  const path = probe.path ? render(probe.path, facts) : null;
  const abs = path ? (path.startsWith('/') ? path : join(dir, path)) : null;
  const env = { ...process.env, IC_GRADER: '1' };
  try {
    switch (probe.kind) {
      case 'exit': return spawnSync(probe.command[0], render(probe.command.slice(1), facts), { cwd: dir, stdio: 'ignore', timeout: 60_000, env }).status;
      case 'stdout': return (spawnSync(probe.command[0], render(probe.command.slice(1), facts), { cwd: dir, encoding: 'utf8', timeout: 60_000, env }).stdout ?? '').trim().slice(0, PROBE_STDOUT_CAP + 1);
      case 'sha256': return existsSync(abs!) ? sha256(readFileSync(abs!)) : null;
      case 'exists': return existsSync(abs!);
      case 'attempts': return attemptCount(existsSync(abs!) ? readFileSync(abs!, 'utf8') : null);
      case 'contains': return existsSync(abs!) && readFileSync(abs!, 'utf8').includes(probe.pattern);
      case 'count': return existsSync(abs!) ? readdirSync(abs!).length : 0;
      // A fixed field of the run state the driver recorded, such as whether a native command's instruction was delivered.
      case 'run': return getPath(run, probe.field) ?? null;
      default: return { error: 'unknown_probe_kind' };
    }
  } catch {
    return { error: 'probe_failed' };
  }
}

/** Values that must never leave the container: the injected credential as the host stores it. */
async function containerSecrets(host: string): Promise<string[]> {
  const secrets: string[] = [];
  if (host === 'v1') {
    const entry = readJson(join(WORK, 'xdg', 'data', 'opencode', 'auth.json'))?.openai;
    if (entry?.access) secrets.push(entry.access);
    if (entry?.accountId?.length >= 8) secrets.push(entry.accountId);
  } else {
    try {
      const res = await api('/api/credential');
      for (const c of unwrap(res.body) ?? []) {
        if (c?.value?.access) secrets.push(c.value.access);
        const account = c?.value?.metadata?.accountID;
        if (typeof account === 'string' && account.length >= 8) secrets.push(account);
      }
    } catch { /* server gone: fall back to shape scan */ }
  }
  return secrets;
}

const TOKEN_SHAPES = [/eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\./, /\bsk-[A-Za-z0-9_-]{20,}/];

/** A session's final text leaves the container clipped at this length; the record says when it was. */
export const FINAL_TEXT_CAP = 8000;
export const ARTIFACT_CAP = 16000;
export const STOP_INSTRUCTION_CAP = 300;

/**
 * What the exported record could not show, so an assessor reads a clipped or partial record as such. A history cut by
 * the page cap is `historyIncomplete`; one whose read failed is `historyFailed` and makes the record unusable evidence.
 * `seq` numbers a
 * session's calls in order and concatenates sessions in tree order; the record carries no cross-session timestamps, so
 * the order of calls in different sessions is unknown. Tool outputs are never exported.
 */
export function evidenceLimits(parts: {
  finalTextTruncated: string[]; toolArgsTruncated: { session: string; seq: number; fields: string[] }[]; artifactsTruncated: string[];
  probesTruncated: string[]; requestsTruncated: boolean; historyIncomplete: string[]; historyFailed: { session: string; code: string }[];
  callsWithUnknownOutcome: number;
}): Json {
  return {
    seqScope: 'within_session_only', crossSessionOrder: 'unavailable', toolOutputs: 'not_exported', ...parts,
  };
}

async function exportCase(input: Json): Promise<Json> {
  const { host } = input;
  const scenario = group(input.scenario);
  const facts = readJson(join(STATE, 'facts.json'), {});
  const run = readJson(join(STATE, 'run.json'), {});
  const tree = run.sessionId ? await sessionTree(host, run.sessionId) : [];
  const sessions: Json[] = [];
  const finalTextTruncated: string[] = [];
  const { histories, historyIncomplete, historyFailed } = await readHistories(host, tree);
  for (const node of tree) {
    const assistant = (histories.get(node.id) ?? []).filter((m) => m.role === 'assistant');
    const agent = node.agent ?? assistant.find((m) => m.agent)?.agent ?? null;
    const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    for (const m of assistant) {
      const t = m.tokens ?? {};
      tokens.input += t.input ?? 0;
      tokens.output += t.output ?? 0;
      tokens.reasoning += t.reasoning ?? 0;
      tokens.cacheRead += t.cache?.read ?? 0;
      tokens.cacheWrite += t.cache?.write ?? 0;
    }
    const models = [...new Map(assistant.filter((m) => m.model).map((m) => [JSON.stringify(m.model), m.model])).values()];
    const final = clipText([...assistant].reverse().find((m) => m.text)?.text ?? '', FINAL_TEXT_CAP);
    if (final.truncated) finalTextTruncated.push(node.id);
    sessions.push({
      id: node.id, parentId: node.parentId, agent, role: node.id === run.sessionId ? 'primary' : 'child',
      assistantMessages: assistant.length, retries: assistant.reduce((n, m) => n + (m.retries ?? 0), 0),
      errors: assistant.filter((m) => m.error).length, errorNames: [...new Set(assistant.map((m) => m.error).filter(Boolean))],
      models, tokens,
      finalText: final.text, finalTextChars: final.chars, finalTextTruncated: final.truncated,
    });
  }
  const toolCalls: Json[] = [];
  const toolArgsTruncated: { session: string; seq: number; fields: string[] }[] = [];
  for (const session of sessions) {
    for (const m of histories.get(session.id) ?? []) {
      if (m.role !== 'assistant') continue;
      for (const call of m.tools) {
        const seq = toolCalls.length;
        const clipped = clipToolArgs(call.name, call.input);
        if (clipped.truncated.length) toolArgsTruncated.push({ session: session.id, seq, fields: clipped.truncated });
        toolCalls.push({
          seq, session: session.id, agent: session.agent, tool: neutralTool(call.name), status: call.status,
          args: clipped.args, outcome: toolOutcome(call, session, sessions),
        });
      }
    }
  }
  const probes: Json = {};
  // Attempt logs are read before any probe that runs project code. The grader's own probes also set IC_GRADER.
  const ordered = [...(scenario.probes ?? [])].sort((a: Json, b: Json) => Number(b.kind === 'attempts') - Number(a.kind === 'attempts'));
  const probesTruncated: string[] = [];
  for (const probe of ordered) {
    const value = runProbe(probe, facts, run);
    if (typeof value === 'string' && value.length > PROBE_STDOUT_CAP) {
      probesTruncated.push(probe.name);
      probes[probe.name] = value.slice(0, PROBE_STDOUT_CAP);
    } else probes[probe.name] = value;
  }
  const artifacts: Json = {};
  const artifactsTruncated: string[] = [];
  for (const artifact of scenario.artifacts ?? []) {
    const path = render(artifact.path, facts);
    const abs = path.startsWith('/') ? path : join(PROJ, path);
    const clipped = existsSync(abs) ? clipText(readFileSync(abs, 'utf8'), ARTIFACT_CAP) : null;
    if (clipped?.truncated) artifactsTruncated.push(artifact.name);
    artifacts[artifact.name] = clipped?.text ?? null;
  }
  const observed = observedRequests(new Set(sessions.map((x) => x.id)));
  const record = {
    schema: 'ic-case-export/v3', host, scenario: scenario.id, facts,
    run: {
      exit: run.exit, timedOut: run.timedOut, asked: run.asked, questionsRejected: run.questionsRejected ?? 0, durationMs: run.durationMs,
      ...(run.commandDelivery ? { commandDelivery: run.commandDelivery } : {}),
    },
    // Only the case's own sessions: fixture setup ran earlier on the mock provider in the same container.
    sessions, toolCalls, probes, artifacts, requests: observed.requests,
    limits: evidenceLimits({
      finalTextTruncated, toolArgsTruncated, artifactsTruncated, probesTruncated, requestsTruncated: observed.truncated, historyIncomplete, historyFailed,
      callsWithUnknownOutcome: toolCalls.filter((c) => c.outcome?.result === 'unknown').length,
    }),
  };
  const text = JSON.stringify(record);
  const secrets = await containerSecrets(host);
  if (secrets.some((s) => text.includes(s)) || TOKEN_SHAPES.some((shape) => shape.test(text))) {
    return { ok: false, failure: 'export_contaminated', host, scenario: scenario.id };
  }
  return { ok: true, record };
}

async function runScenario(input: Json): Promise<Json> {
  const { host, mode, model, timeoutMs } = input;
  const scenario = group(input.scenario);
  const facts = readJson(join(STATE, 'facts.json'), {});
  let prompt = render(scenario.prompt, facts);
  if (mode === 'mock') prompt = `${prompt}\n${scriptDirective(render(scenario.rehearsal.script, facts))}`;
  const modelRef = mode === 'mock' ? `mock/${SCENARIOS.model.mock}` : `openai/${model}`;
  const run = await runPrompt(host, { agent: scenario.primary, modelRef, prompt, command: scenario.command?.name }, timeoutMs);
  if ((run.asked || run.timedOut) && run.sessionId) await interruptSession(host, run.sessionId);
  // A native command's delivery is read back from the primary's own user messages, so it holds for rehearsal and paid cases alike.
  const delivery = scenario.command && run.sessionId
    ? commandDelivery((await messages(host, run.sessionId)).filter((m) => m.role === 'user').map((m) => m.text), prompt, packageDistText(), scenario.command.stopMarker)
    : null;
  const summary = {
    exit: run.exit, sessionId: run.sessionId, asked: run.asked, questionsRejected: run.questionsRejected, timedOut: run.timedOut, durationMs: run.durationMs,
    ...(delivery ? { commandDelivery: { command: scenario.command.name, ...delivery } } : {}),
  };
  writeFile(join(STATE, 'run.json'), JSON.stringify(summary));
  return { ok: Boolean(run.sessionId), ...summary };
}

// ---------------------------------------------------------------------------------------------------------------
// Credential handling inside the container. The payload arrives on stdin and is forwarded to the local server only.

async function injectAuth(input: Json): Promise<Json> {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let request: Json;
  try { request = JSON.parse(raw); } catch { return { ok: false, failure: 'auth_payload_malformed' }; }
  raw = '';
  const access = input.host === 'v1' ? request.body?.access : request.body?.value?.access;
  if (typeof access !== 'string') return { ok: false, failure: 'auth_payload_malformed' };
  const refresh = input.host === 'v1' ? request.body?.refresh : request.body?.value?.refresh;
  if (refresh !== REFRESH_SENTINEL) return { ok: false, failure: 'refresh_not_sentinel' };
  writeFile(join(STATE, 'access.sha256'), sha256(access));
  const res = await api(request.path, { method: request.method, body: JSON.stringify(request.body) });
  request = null;
  return { ok: res.ok, status: res.status };
}

async function verifyCredential(input: Json): Promise<Json> {
  const expected = readFileSync(join(STATE, 'access.sha256'), 'utf8');
  let stored: Json = null;
  if (input.host === 'v1') {
    const entry = readJson(join(WORK, 'xdg', 'data', 'opencode', 'auth.json'))?.openai;
    stored = entry ? { access: entry.access, refresh: entry.refresh } : null;
  } else {
    const res = await api('/api/credential');
    const value = (unwrap(res.body) ?? []).find((c: Json) => c.integrationID === 'openai')?.value;
    stored = value ? { access: value.access, refresh: value.refresh } : null;
  }
  return {
    ok: true,
    present: Boolean(stored),
    sentinelRetained: stored?.refresh === REFRESH_SENTINEL,
    accessUnchanged: stored ? sha256(stored.access) === expected : false,
  };
}

/** How many credential values the export scan would look for; never the values themselves. */
async function secretProbe(input: Json): Promise<Json> {
  return { ok: true, count: (await containerSecrets(input.host)).length };
}

/** The host's OpenAI catalog. A stored credential reloads providers asynchronously, so an empty list is retried. */
async function catalog(input: Json): Promise<Json> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const models = await catalogOnce(input.host);
    if (models.length > 0) return { ok: true, models };
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: true, models: [] };
}

async function catalogOnce(host: string): Promise<Json[]> {
  const models: Json[] = [];
  if (host === 'v1') {
    const res = await api(`/config/providers?directory=${encodeURIComponent(PROJ)}`);
    for (const provider of res.body?.providers ?? []) {
      if (provider.id !== 'openai') continue;
      for (const [id, m] of Object.entries(provider.models ?? {}) as [string, Json][]) {
        models.push({ id, toolCall: Boolean(m.capabilities?.toolcall ?? m.tool_call), variants: Object.keys(m.variants ?? {}) });
      }
    }
  } else {
    const res = await api(`/api/model?directory=${encodeURIComponent(PROJ)}`);
    for (const m of unwrap(res.body) ?? []) {
      if ((m.providerID ?? m.provider?.id) !== 'openai') continue;
      models.push({ id: m.id, toolCall: Boolean(m.capabilities?.tools ?? m.capabilities?.toolcall), variants: Array.isArray(m.variants) ? m.variants.map((v: Json) => v.id ?? v) : Object.keys(m.variants ?? {}) });
    }
  }
  return models;
}

/**
 * What the host-side preflight reads back. Ready means the primary answered without an error and its whole history
 * was read; a failed history read is a fixed failure code, never an empty or partial answer taken as complete.
 */
export function preflightReply(run: Json, read: HistoryRead, observed: { requests: Json[]; truncated: boolean }): Json {
  const assistant = read.history.filter((m) => m.role === 'assistant');
  return {
    ok: run.exit === 0 && !read.failure && assistant.some((m) => m.text && !m.error),
    ...(read.failure ? { failure: read.failure } : {}),
    exit: run.exit,
    sessionId: run.sessionId,
    assistantMessages: assistant.length,
    errors: assistant.filter((m) => m.error).length,
    errorNames: [...new Set(assistant.map((m) => m.error).filter(Boolean))],
    models: [...new Map(assistant.filter((m) => m.model).map((m) => [JSON.stringify(m.model), m.model])).values()],
    tokens: assistant.map((m) => m.tokens ?? null),
    requests: observed.requests,
    requestsTruncated: observed.truncated,
    historyIncomplete: !read.failure && !read.complete,
  };
}

async function preflight(input: Json): Promise<Json> {
  const run = await runPrompt(input.host, { agent: 'build', modelRef: `openai/${input.model}`, prompt: 'Reply with the single word: ready' }, 120_000);
  const tree = run.sessionId ? await sessionTree(input.host, run.sessionId) : [];
  const read: HistoryRead = tree.length ? await messagePages(input.host, tree[0].id) : { history: [], complete: true, failure: null };
  return preflightReply(run, read, observedRequests(new Set(tree.map((x: Json) => x.id))));
}

// ---------------------------------------------------------------------------------------------------------------
// Isolation probe: what the process inside the container actually sees.

function isolationProbe(): Json {
  const read = (path: string) => { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } };
  const limits = read('/proc/self/limits') ?? '';
  const core = limits.split('\n').find((l) => l.startsWith('Max core file size'));
  const mounts = (read('/proc/mounts') ?? '').split('\n').map((l) => l.split(' ')).filter((p) => p.length > 3)
    // Overlay lowerdir/upperdir paths are daemon internals; keep only flags and tmpfs sizing.
    .map(([source, target, fstype, options]) => ({ source, target, fstype, options: options.split(',').filter((o) => !o.includes('=') || /^(size|mode|uid|gid)=/.test(o)).join(',') }));
  const pick = (target: string) => mounts.filter((m) => m.target === target).at(-1) ?? null;
  const processes = readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map((pid) => {
    const status = read(`/proc/${pid}/status`) ?? '';
    const field = (name: string) => new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(status)?.[1] ?? null;
    return { pid: Number(pid), ppid: Number(field('PPid')), uid: Number(field('Uid')), cmdline: (read(`/proc/${pid}/cmdline`) ?? '').split('\0').filter(Boolean) };
  });
  // PID 1 is docker-init, whose own command line names the guard it started; the guard is its child.
  const guard = processes.find((p) => p.pid !== 1 && p.cmdline.some((a) => a.endsWith('/guard.mjs')) && p.cmdline.includes('serve')) ?? null;
  return {
    ok: true,
    uid: process.getuid?.(),
    pid1: read('/proc/1/comm'),
    guard: guard ? { pid: guard.pid, ppid: guard.ppid, uid: guard.uid } : null,
    corePattern: read('/proc/sys/kernel/core_pattern'),
    kernelRelease: read('/proc/sys/kernel/osrelease'),
    memoryMax: read('/sys/fs/cgroup/memory.max'),
    swapMax: read('/sys/fs/cgroup/memory.swap.max'),
    coreLimit: core ? core.replace(/\s+/g, ' ').replace('Max core file size ', '').trim() : null,
    root: pick('/'),
    work: pick('/work'),
    tmp: pick('/tmp'),
    otherWritableMounts: mounts.filter((m) => !['/', '/work', '/tmp'].includes(m.target) && /(^|,)rw(,|$)/.test(m.options) && !['proc', 'sysfs', 'cgroup', 'cgroup2', 'devpts', 'mqueue', 'tmpfs'].includes(m.fstype)).map((m) => m.target),
    envNames: Object.keys(process.env).sort(),
  };
}

/**
 * Lifetime rehearsal canary: a detached process in its own session that ignores TERM, HUP and INT and keeps writing a
 * heartbeat. Only the PID-namespace teardown that follows the guard's exit can stop it.
 */
async function canary(): Promise<Json> {
  const child = spawn('/bin/sh', ['-c', 'trap "" TERM HUP INT; while :; do date +%s > /work/canary; sleep 1; done'], { detached: true, stdio: 'ignore' });
  child.unref();
  await new Promise((r) => setTimeout(r, 2500));
  const beat = Number(readFileSync('/work/canary', 'utf8').trim());
  // An agent-uid process must not be able to stop the guard; a stop that succeeds is undone and reported.
  const guardPid = isolationProbe().guard?.pid;
  let guardSignal = 'no_guard';
  if (guardPid) {
    try {
      process.kill(guardPid, 'SIGSTOP');
      process.kill(guardPid, 'SIGCONT');
      guardSignal = 'ALLOWED';
    } catch (error) {
      guardSignal = (error as Json)?.code ?? 'error';
    }
  }
  return { ok: true, pid: child.pid, heartbeat: Number.isFinite(beat) && Math.abs(Date.now() / 1000 - beat) < 5, guardSignal };
}

// ---------------------------------------------------------------------------------------------------------------
// Credential-free wiring observation: roles, commands, provider-facing tool schemas, packaged reference reads under
// stock permissions, a non-Hive command consumer and native same-name override behavior.

function requests(): Json[] {
  const path = join(STATE, 'requests.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function toolDescriptors(tools: Json[]): Json {
  const out: Json = {};
  for (const t of tools) {
    const fn = t.function ?? t;
    if (!fn?.name) continue;
    const props = fn.parameters?.properties ?? {};
    out[fn.name] = {
      description: fn.description ?? '',
      params: Object.fromEntries(Object.entries(props).map(([k, v]: [string, Json]) => [k, v?.description ?? ''])),
    };
  }
  return out;
}

/** v2 Code Mode catalog entries: each `- name (1 tool)` block up to the next top-level entry, with field comments. */
export function codeModeBlocks(system: string, names: string[]): Json {
  const out: Json = {};
  for (const name of names) {
    const start = system.indexOf(`- ${name} (`);
    if (start < 0) continue;
    const rest = system.slice(start + 2);
    const end = rest.search(/\n- /);
    out[name] = (end < 0 ? rest : rest.slice(0, end)).slice(0, 6000);
  }
  return out;
}

/** Field documentation comments in one Code Mode declaration block: a doc comment directly before `field?: type`. */
export function codeModeFieldDocs(block: string): Json {
  const out: Json = {};
  for (const m of block.matchAll(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/g)) {
    out[m[2]] = m[1].split('\n').map((line) => line.replace(/^\s*\*?\s?/, '')).join(' ').trim();
  }
  return out;
}

/**
 * Field-contract findings for what one host showed the model: direct tool schemas first, then Code Mode declarations
 * for the reads that host exposes only there. A Code Mode field without a doc comment is present with an empty text.
 */
export function toolFieldContract(descriptors: Json, codeModeDeclarations: Json): Json {
  const direct = Object.fromEntries(Object.entries(descriptors).map(([tool, d]: [string, Json]) => [tool, d.params]));
  const codeMode = Object.fromEntries(Object.entries(codeModeDeclarations).map(([tool, block]: [string, Json]) => {
    const fields = Object.fromEntries([...String(block).matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((m) => [m[1], '']));
    return [tool, { ...fields, ...codeModeFieldDocs(String(block)) }];
  }));
  return fieldContractFindings(direct, codeMode);
}

const PACKAGE_ROOT = '/opt/ic/plugin/node_modules/oc-arkive';
// References the instruction-contracts plan adds in later tasks. Wiring reports their state so a generic reference
// success can never be read as their delivery; they become required only once an installed SKILL.md points to them.
export const PLANNED_REFERENCES = [
  'background-delegation/references/board-protocol.md',
  'dispatching-parallel-agents/references/launch-examples.md',
  'parallel-exploration/references/research-examples.md',
  'executing-plans/references/task-milestones.md',
  'writing-plans/references/verification-planning.md',
  'context-engineering/references/mutation-and-recovery.md',
  'systematic-debugging/references/diagnostic-techniques.md',
];

/**
 * Reference files each installed skill points to from its SKILL.md. A pointer is what makes a reference required: a
 * role told to read it must be able to. Pointers to missing files and unpointed reference files are reported apart.
 */
export function skillReferencePointers(skillsRoot: string): Json {
  const out: Json = {};
  if (!existsSync(skillsRoot)) return out;
  for (const skill of readdirSync(skillsRoot).sort()) {
    const entry = join(skillsRoot, skill, 'SKILL.md');
    if (!existsSync(entry)) continue;
    const pointed = [...new Set([...readFileSync(entry, 'utf8').matchAll(/references\/([A-Za-z0-9._-]+\.md)/g)].map((m) => m[1]))].sort();
    const refsDir = join(skillsRoot, skill, 'references');
    const files = existsSync(refsDir) ? readdirSync(refsDir).filter((f) => f.endsWith('.md')).sort() : [];
    if (pointed.length === 0 && files.length === 0) continue;
    out[skill] = { pointed: pointed.filter((f) => files.includes(f)), broken: pointed.filter((f) => !files.includes(f)), unpointed: files.filter((f) => !pointed.includes(f)) };
  }
  return out;
}

/**
 * A sentence of the command body the consumer received that the installed artifact itself contains. Neither host's
 * catalog exposes a v2 command template, so delivery is proven against the package bytes: the prompt must carry, beyond
 * the caller's own text and the route-snapshot footer, at least one body sentence found verbatim in the plugin dist.
 * With `marker`, only a delivered sentence that contains it counts.
 */
export function deliveredBodySentence(received: string, callerText: string, distText: string, marker?: string): string | null {
  const body = received.split(callerText).join('\n');
  const footer = /route snapshot|standing constraints|session constraints|feature constraints|hive-route-snapshot/i;
  for (const line of body.split('\n')) {
    if (footer.test(line)) continue;
    for (const sentence of line.split(/(?<=\.)\s+/)) {
      const candidate = sentence.trim();
      if (candidate.length >= 40 && distText.includes(candidate) && (marker === undefined || candidate.includes(marker))) return candidate;
    }
  }
  return null;
}

/**
 * What the primary's user messages show of a native command: whether any body sentence of the installed package was
 * delivered, and whether the one carrying the scenario's `stopMarker` was. Only booleans and the delivered package
 * sentence leave the container, never the prompt.
 */
export function commandDelivery(userTexts: string[], callerText: string, distText: string, stopMarker: string): Json {
  const find = (marker?: string) => userTexts.map((text) => deliveredBodySentence(text, callerText, distText, marker)).find((sentence) => sentence !== null) ?? null;
  const stop = find(stopMarker);
  const clipped = stop === null ? null : clipText(stop, STOP_INSTRUCTION_CAP);
  return {
    userMessages: userTexts.length, bodyDelivered: find() !== null, stopInstructionDelivered: stop !== null,
    stopInstruction: clipped?.text ?? null, stopInstructionChars: clipped?.chars ?? 0, stopInstructionTruncated: clipped?.truncated ?? false,
  };
}

function packageDistText(): string {
  const dir = join(PACKAGE_ROOT, 'dist');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n') : '';
}

async function toolCallsUnder(host: string, rootId: string | null): Promise<Json[]> {
  const tree = rootId ? await sessionTree(host, rootId) : [];
  const calls: Json[] = [];
  for (const node of tree) {
    for (const m of await messages(host, node.id)) {
      for (const t of m.tools) {
        calls.push({ session: node.id, agent: node.agent, tool: neutralTool(t.name), status: t.status, args: allowlistArgs(t.name, t.input), output: typeof t.output === 'string' ? t.output : '' });
      }
    }
  }
  return calls;
}

async function wiring(input: Json): Promise<Json> {
  const { host } = input;
  const results: Json = { host };
  const mockRef = `mock/${SCENARIOS.model.mock}`;
  const manifest = readJson(join(PACKAGE_ROOT, 'plugin.json'), {});
  const roleExposure: Json = {};
  const primaries = ['hive-builder', 'swarm-orchestrator', 'architect-planner', 'hive-master', 'dash-reviewer', 'vulnerability-review-primary'];
  for (const role of HIVE_ROLES) {
    const before = requests().length;
    const marker = `wiring-role-${role}`;
    if (primaries.includes(role)) {
      await runPrompt(host, { agent: role, modelRef: mockRef, prompt: `${marker}\n${scriptDirective([{ op: 'text', text: 'ok' }])}` }, 120_000);
    } else {
      await runPrompt(host, { agent: 'hive-builder', modelRef: mockRef, prompt: `wiring parent\n${scriptDirective([{ op: 'dispatch', agent: role, prompt: marker, script: [{ op: 'text', text: 'ok' }] }, { op: 'text', text: 'ok' }])}` }, 120_000);
    }
    const seen = requests().slice(before).find((r) => r.lastUser.includes(marker) && r.tools.length > 0);
    roleExposure[role] = seen
      ? { observed: true, systemBytes: Buffer.byteLength(seen.system), systemSha256: sha256(seen.system), toolCount: seen.tools.length, toolSchemaBytes: Buffer.byteLength(JSON.stringify(seen.tools)) }
      : { observed: false };
  }
  results.roleExposure = roleExposure;
  // v2 activates plugins on the first prompt, so the native catalogs are listed only after the role runs.
  const agentsRes = host === 'v1' ? await api('/agent') : await api(`/api/agent?directory=${encodeURIComponent(PROJ)}`);
  const agents = (unwrap(agentsRes.body) ?? []).map((a: Json) => a.name ?? a.id);
  results.roles = Object.fromEntries(HIVE_ROLES.map((r) => [r, agents.includes(r)]));
  const commandsRes = host === 'v1' ? await api('/command') : await api(`/api/command?directory=${encodeURIComponent(PROJ)}`);
  const commandList = unwrap(commandsRes.body) ?? [];
  const commands = commandList.map((c: Json) => c.name ?? c.id);
  results.commands = Object.fromEntries(HIVE_COMMANDS.map((c) => [c, commands.includes(c)]));

  // Provider-facing tool contract for the full-access role, against the installed package's own tool manifest.
  const builder = requests().find((r) => r.lastUser.includes('wiring-role-hive-builder'));
  const descriptors = builder ? toolDescriptors(builder.tools) : {};
  const codeModeNames = builder ? [...new Set([...builder.system.matchAll(/tools\.(hive_[a-z_]+)/g)].map((m) => m[1]))] : [];
  results.hiveToolSchemas = Object.fromEntries(Object.entries(descriptors).filter(([name]) => name.startsWith('hive_')));
  results.codeModeHiveTools = codeModeNames;
  results.codeModeDeclarations = builder ? codeModeBlocks(builder.system, codeModeNames) : {};
  const expectedTools: string[] = Array.isArray(manifest.tools) ? manifest.tools : [];
  results.toolContract = {
    expected: expectedTools.length,
    missing: expectedTools.filter((t) => !(t in results.hiveToolSchemas) && !codeModeNames.includes(t)),
    unexpected: [...Object.keys(results.hiveToolSchemas), ...codeModeNames].filter((t) => !expectedTools.includes(t)),
    undescribed: [
      ...Object.entries(results.hiveToolSchemas).filter(([, d]: [string, Json]) => !d.description.trim()).map(([t]) => t),
      ...codeModeNames.filter((t) => !/\S/.test((results.codeModeDeclarations[t] ?? '').split('\n').slice(1).join('\n'))),
    ],
    paramNames: Object.fromEntries(Object.entries(results.hiveToolSchemas).map(([t, d]: [string, Json]) => [t, Object.keys(d.params).sort()])),
    // Informational: undescribed fields. The relied-upon fields are judged by `fieldContract` below.
    undescribedParams: Object.fromEntries(Object.entries(results.hiveToolSchemas)
      .map(([t, d]: [string, Json]) => [t, Object.entries(d.params).filter(([, v]) => !v).map(([k]) => k)])
      .filter(([, v]) => (v as string[]).length > 0)),
  };
  results.fieldContract = toolFieldContract(descriptors, results.codeModeDeclarations);

  // Every reference an installed skill points to must be readable by a child under stock permissions. A same-name
  // user skill replaces the packaged one, so its packaged pointers are not reachable and are reported apart.
  const pointers = skillReferencePointers(join(PACKAGE_ROOT, 'skills'));
  const userSkillsDir = join(WORK, 'user-skills');
  const overridden = existsSync(userSkillsDir) ? readdirSync(userSkillsDir) : [];
  const referenceReads: Json[] = [];
  for (const [skill, info] of Object.entries(pointers) as [string, Json][]) {
    if (overridden.includes(skill) || info.pointed.length === 0) continue;
    const marker = `wiring-reference-${skill}`;
    const run = await runPrompt(host, {
      agent: 'hive-builder', modelRef: mockRef,
      prompt: `wiring reference\n${scriptDirective([{ op: 'dispatch', agent: 'scout-researcher', prompt: marker, script: [
        { op: 'skill', name: skill },
        ...info.pointed.map((file: string) => ({ op: 'read', path: `{{skillDir:${skill}}}/references/${file}` })),
        { op: 'text', text: 'read done' },
      ] }, { op: 'text', text: 'ok' }])}`,
    }, 180_000);
    const calls = await toolCallsUnder(host, run.sessionId);
    for (const file of info.pointed) {
      const read = calls.find((c) => c.tool === 'read' && c.agent === 'scout-researcher' && (c.args.path ?? '').endsWith(`/${skill}/references/${file}`));
      referenceReads.push({ skill, file, readBy: 'scout-researcher', readCompleted: read?.status === 'completed' && read.output.length > 0, asked: run.asked ? run.asked.kind : null });
    }
  }
  results.references = {
    pointers,
    reads: referenceReads,
    overriddenSkills: overridden,
    planned: Object.fromEntries(PLANNED_REFERENCES.map((ref) => {
      const [skill, , file] = ref.split('/');
      const row = referenceReads.find((r) => r.skill === skill && r.file === file);
      return [ref, row ? (row.readCompleted ? 'delivered' : 'pointed_not_read') : existsSync(join(PACKAGE_ROOT, 'skills', ref)) ? 'present_unpointed' : 'absent'];
    })),
  };

  // Non-Hive primary invoking a Hive command: the native build agent must receive the command's actual body, and can
  // then load the execution skill and read the references it points to.
  const commandName = 'start-execution';
  const before = requests().length;
  const followUp = (pointers['executing-plans']?.pointed ?? []).map((file: string) => ({ op: 'read', path: `{{skillDir:executing-plans}}/references/${file}` }));
  const commandText = `wiring-command ${scriptDirective([{ op: 'skill', name: 'executing-plans' }, ...followUp, { op: 'text', text: 'ok' }])}`;
  const commandRun = await runPrompt(host, { agent: 'build', modelRef: mockRef, command: commandName, prompt: commandText }, 120_000);
  const commandResult = commandRun.exit;
  const commandSession = commandRun.sessionId;
  // A run that did not finish leaves its native session live; stop it before any other wiring work uses the host.
  const commandInterrupted = commandSession && (commandResult !== 0 || commandRun.timedOut || commandRun.asked) ? await interruptSession(host, commandSession) : null;
  const cmdRequest = requests().slice(before).find((r) => r.lastUser.includes('wiring-command'));
  const commandCalls = await toolCallsUnder(host, commandSession);
  const bodySentence = cmdRequest ? deliveredBodySentence(cmdRequest.lastUser, commandText, packageDistText()) : null;
  results.nonHiveCommand = {
    command: commandName, result: commandResult, timedOut: commandRun.timedOut, asked: commandRun.asked?.kind ?? null, interrupted: commandInterrupted,
    observed: Boolean(cmdRequest),
    bodyDelivered: bodySentence !== null, bodySentence: bodySentence?.slice(0, 200) ?? null,
    bodyBytes: cmdRequest ? Buffer.byteLength(cmdRequest.lastUser) : 0,
    skillLoaded: commandCalls.some((c) => c.tool === 'skill' && c.args.name === 'executing-plans' && c.status === 'completed'),
    referenceReads: (pointers['executing-plans']?.pointed ?? []).map((file: string) => ({
      file,
      readCompleted: commandCalls.some((c) => c.tool === 'read' && (c.args.path ?? '').endsWith(`/executing-plans/references/${file}`) && c.status === 'completed' && c.output.length > 0),
    })),
  };

  // Same-name user override: listed, resolved to the user skill, and the body a role loads is the user's.
  const skillsRes = host === 'v1' ? await api('/skill') : await api(`/api/skill?directory=${encodeURIComponent(PROJ)}`);
  const skills = unwrap(skillsRes.body) ?? [];
  const override = skills.find((s: Json) => s.name === 'adversarial-review');
  const overrideRun = await runPrompt(host, { agent: 'hive-builder', modelRef: mockRef, prompt: `wiring override\n${scriptDirective([{ op: 'skill', name: 'adversarial-review' }, { op: 'text', text: 'ok' }])}` }, 120_000);
  const overrideLoad = (await toolCallsUnder(host, overrideRun.sessionId)).find((c) => c.tool === 'skill' && c.args.name === 'adversarial-review');
  const userBody = group('skill-override-reference').fixture.userSkills['adversarial-review/SKILL.md'] as string;
  const userMarker = userBody.split('\n').filter((line) => line.trim()).at(-1) ?? null;
  results.override = {
    listed: Boolean(override),
    location: override ? String(override.location ?? override.path ?? override.directory ?? '').replace(HOME, '~') : null,
    resolvesToUserSkill: override ? JSON.stringify(override).includes('/work/user-skills') : false,
    loadedUserBody: Boolean(userMarker && overrideLoad?.status === 'completed' && overrideLoad.output.includes(userMarker)),
  };
  results.skillExposure = materializedSkillSizes();
  return { ok: true, wiring: results };
}

/** Bytes of each materialized Hive skill entry point and its references, the depth a role can load on demand. */
function materializedSkillSizes(): Json {
  const root = join(HOME, '.config', 'opencode', 'agent-hive', 'generated', 'opencode-skills');
  const out: Json = {};
  if (!existsSync(root)) return out;
  for (const bundle of readdirSync(root).filter((name) => name !== '0000stale')) {
    for (const skill of readdirSync(join(root, bundle))) {
      const dir = join(root, bundle, skill);
      if (!existsSync(join(dir, 'SKILL.md'))) continue;
      const refs = join(dir, 'references');
      out[skill] = {
        skillBytes: statSync(join(dir, 'SKILL.md')).size,
        referenceBytes: existsSync(refs) ? readdirSync(refs).reduce((n, f) => n + statSync(join(refs, f)).size, 0) : 0,
      };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Build-time identity reports, run inside the image builds (no /work, no credentials).

function versionOf(command: string, args: string[], cwd?: string): string | null {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd });
  return result.status === 0 ? result.stdout.trim().split('\n').at(-1) ?? null : null;
}

/** Dependency tree as name -> version/children only, so registry URLs and integrity strings do not affect identity. */
export function normalizeGraph(node: Json): Json {
  const deps = node?.dependencies ?? {};
  return Object.fromEntries(Object.keys(deps).sort().map((name) => [name, { version: deps[name].version ?? null, dependencies: normalizeGraph(deps[name]) }]));
}

function npmGraph(prefix: string): Json {
  const result = spawnSync('npm', ['ls', '--all', '--json'], { cwd: prefix, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return normalizeGraph(JSON.parse(result.stdout || '{}'));
}

function buildCheckCore(): Json {
  const link = ['/src/packages/opencode-hive/node_modules/hive-core', '/src/node_modules/hive-core'].find((p) => existsSync(p));
  const real = link ? spawnSync('realpath', [link], { encoding: 'utf8' }).stdout.trim() : null;
  const dist = '/src/packages/hive-core/dist';
  return { ok: true, hiveCoreLink: link ?? null, hiveCoreRealpath: real, coreDistBuiltAtMs: existsSync(dist) ? statSync(dist).mtimeMs : null };
}

function buildReport(): Json {
  const core = readJson('/tmp/core-check.json', {});
  const pack = readJson('/tmp/pack.json', [])[0] ?? {};
  const pluginDist = '/src/packages/opencode-hive/dist';
  return {
    node: process.version,
    npm: versionOf('npm', ['--version']),
    bun: versionOf('bun', ['--version']),
    platform: `${process.platform}/${process.arch}`,
    baseImage: process.env.NODE_IMAGE ?? null,
    hiveCoreRealpath: core.hiveCoreRealpath,
    hiveCoreResolvedInArchive: typeof core.hiveCoreRealpath === 'string' && core.hiveCoreRealpath === '/src/packages/hive-core',
    coreBuiltFirst: typeof core.coreDistBuiltAtMs === 'number' && existsSync(pluginDist) && core.coreDistBuiltAtMs < statSync(pluginDist).mtimeMs,
    packName: pack.name ?? null,
    packVersion: pack.version ?? null,
    packEntries: (pack.files ?? []).map((f: Json) => f.path).sort(),
  };
}

function runtimeReport(): Json {
  const hosts: Json = {};
  for (const id of ['v1', 'v2']) {
    const spec = hostSpec(id);
    const prefix = `/opt/ic/${id}`;
    const binary = spawnSync('realpath', [spec.binary], { encoding: 'utf8' }).stdout.trim();
    hosts[id] = {
      version: versionOf(spec.binary, ['--version']),
      binarySha256: existsSync(binary) ? sha256(readFileSync(binary)) : null,
      lockSha256: sha256(readFileSync(join(prefix, 'package-lock.json'))),
      graphSha256: sha256(JSON.stringify(npmGraph(prefix))),
    };
  }
  const plugin = npmGraph('/opt/ic/plugin');
  const pluginVersion = plugin['oc-arkive']?.version ?? null;
  return {
    hosts,
    pluginVersion,
    pluginDependencyGraphSha256: sha256(JSON.stringify(plugin['oc-arkive']?.dependencies ?? {})),
    pluginPeerVersions: Object.fromEntries(Object.entries(plugin).filter(([name]) => name !== 'oc-arkive').map(([name, v]: [string, Json]) => [name, v.version])),
    pluginTarballSha256: sha256(readFileSync('/opt/ic/pkg/oc-arkive.tgz')),
    node: process.version,
    npm: versionOf('npm', ['--version']),
    git: versionOf('git', ['--version']),
    baseImage: process.env.NODE_IMAGE ?? null,
    harnessFilesSha256: sha256(readdirSync(HARNESS).sort().filter((f) => statSync(join(HARNESS, f)).isFile()).map((f) => `${f}:${sha256(readFileSync(join(HARNESS, f)))}`).join('\n')),
  };
}

// ---------------------------------------------------------------------------------------------------------------

const commands: Record<string, (input: Json) => Promise<Json> | Json> = {
  'build-check-core': buildCheckCore,
  'build-report': buildReport,
  'runtime-report': runtimeReport,
  'isolation-probe': isolationProbe,
  canary,
  serve,
  stop: stopServer,
  setup,
  run: runScenario,
  export: exportCase,
  'inject-auth': injectAuth,
  'verify-credential': verifyCredential,
  'secret-probe': secretProbe,
  catalog,
  preflight,
  wiring,
};

async function main(): Promise<void> {
  const [command, rawInput] = process.argv.slice(2);
  if (command === 'mock-provider') {
    serveMock(JSON.parse(rawInput).host);
    return;
  }
  const handler = commands[command];
  if (!handler) fail('unknown_command', command);
  let input: Json = {};
  try { input = rawInput ? JSON.parse(rawInput) : {}; } catch { fail('input_malformed'); }
  try {
    emit(await handler(input));
  } catch (error) {
    // Fixed code only; messages from native layers could carry request detail.
    emit({ ok: false, failure: 'fixture_exception', phase: command, name: (error as Error)?.name ?? 'Error' });
    process.exit(3);
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) await main();
