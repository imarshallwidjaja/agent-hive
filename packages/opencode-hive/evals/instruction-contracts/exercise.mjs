#!/usr/bin/env node
// Supervised qualitative exercises on one exact stock OpenCode host, driven through finite commands. EXERCISES.md owns
// the procedure; `--help` owns the syntax. Node standard library only on the host.
//
//   prepare  credential-free: snapshot inputs, build the candidate, qualify the host and controls with a mock model
//   start    named live run: isolated container, one non-extendable deadline, access-only auth, primary session
//   turn     one supervisor action against the live session
//   inspect  bounded, scanned observation and export; resolves an unknown operation from exact native evidence
//   stop     credential-independent cleanup by exact resource identity
//
// start, turn, inspect and stop of one run are serialized by a kernel-held lock (util-linux flock) on the run's lock
// file, held by the acting process's own open file description: the lock lasts exactly as long as that process, and no
// Docker or other child inherits it.
//
// Command budgets run on this process's monotonic clock. A driver inside the container receives its cutoffs as absolute
// instants on the container's shared clock, translated from a guard reading, so neither a wall-clock change nor a late
// `docker exec` start gives it more time.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CredentialError, credentialFromSnapshot, evidenceScanner, fingerprintWire, hostAuthPath, scanValue, snapshotAuthFile,
} from './credentials.mjs';
import { GUARD_EXIT_CODE } from './guard.mjs';
import { HOST_IDS, HIVE_ROLES, authRequest, exerciseMessageId, nativeStorePath, requiredLifetimeMs, splitModelRef } from './hosts.mjs';
import {
  AGENT_USER, Docker, GUARD, GUARD_USER, HarnessError, ISOLATION, Journal, Resources, assessContainerIsolation, build,
  containerCreateArgs, createRunDir, exerciseCoreFailures, gitOut, outstandingFromLedger, resolveIdentities, runtimeFailures,
  runtimeIdentity, sha256File, sha256Text, verifyDockerBoundary, writeOnce,
} from './runtime.mjs';

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = fileURLToPath(import.meta.url);
const DRIVER = '/opt/ic/harness/exercise-driver.ts';
const FIXTURE = '/opt/ic/harness/fixture.ts';
export const PROJECT_ROOT = '/work/proj';

export const SETUP_SECONDS = 1260;
export const LIVE_MIN_SECONDS = 61;
export const LIVE_MAX_SECONDS = 1800;
export const NO_NEW_WORK_MS = 60_000;
/** An interrupt is the one action admitted inside the final window; it still needs time to be delivered. */
export const INTERRUPT_FLOOR_MS = 5_000;
export const LIFETIME_MARGIN_MS = 600_000;
/** The release gate's share of the post-arm window: the final continuity check and scan run inside it. */
const GATE_RESERVE_MS = 12_000;
export const COMMAND_MS = Object.freeze({ prepare: 7_200_000, start: SETUP_SECONDS * 1000, postArm: 60_000, turn: 60_000, inspect: 60_000, stop: 120_000 });
const LOCK_WAIT_SECONDS = 10;
const LOCK_BUSY = 75;
const QUALIFICATION_BUDGET_SECONDS = 900;
const QUALIFICATION_MOCK_MODEL = 'mock/ic-exercise-mock';

export const EXIT = Object.freeze({ ok: 0, failed: 1, invalid: 2, busy: 3 });
export const ACTIONS = ['prompt', 'reply', 'permission', 'interrupt', 'approve-plan', 'switch-primary'];
/** The qualification runs a prepared run owns, each in its own directory with its own ledger and lock. */
export const QUALIFICATION_SUBRUNS = Object.freeze(['qualification', 'qualification-interrupt']);
const SUBRUN_LOCK_WAIT_SECONDS = 5;
/** The journal record in which prepare binds a run to the engine and ledger that `stop` must settle. */
const CLEANUP_BINDING = 'cleanup-binding';

// Input bounds.
export const INPUT_LIMITS = Object.freeze({ files: 256, fileBytes: 256 * 1024, totalBytes: 8 * 1024 * 1024, textBytes: 64 * 1024, requestBytes: 64 * 1024, listItems: 32, itemChars: 1024 });

class ExerciseRefusal extends HarnessError {}

// -----------------------------------------------------------------------------------------------------------------
// CLI

const USAGE = {
  overview: `Supervised OpenCode exercises. Read packages/opencode-hive/evals/instruction-contracts/EXERCISES.md first.

  exercise.mjs prepare --candidate-ref <40-hex commit> --host v1|v2 --input <request.json> --run-id <id> --output-root <abs dir>
  exercise.mjs start   --run <run dir> --authorization <authorization.json> --budget-seconds <61..1800>
  exercise.mjs turn    --run <run dir> --operation <operation.json>
  exercise.mjs inspect --run <run dir> [--request <inspection.json>]
  exercise.mjs stop    --run <run dir>
  exercise.mjs --help [prepare|start|turn|inspect|stop]

Every command prints one JSON status line; that status is authoritative. Exit 0: completed safely (including an
acknowledged submission or an observed pending interaction). 2: invalid input. 3: lock busy, or an unresolved
operation that needs inspect --request with "resolve", or stop. 1: a failed safety or runtime check, or a refusal.
Successful collection is not a qualitative verdict.`,
  prepare: `prepare --candidate-ref <commit> --host v1|v2 --input <request.json> --run-id <id> --output-root <abs dir>

Credential-free. Snapshots request.json and its files, builds the committed candidate and the clean committed tooling,
and qualifies the selected exact host with a loopback mock model and a synthetic credential. Bounded by 7200 s. Holds
the run's lock until it ends, so stop is busy meanwhile.

request.json (schema "ic-exercise-request/v1"; paths relative to the request file's directory):
  question         string: the qualitative question
  observables      [string]: what the supervisor will look for
  stopConditions   [string]: when the supervisor stops the run
  model            { "ref": "openai/<model>", "variant": <string|null> }
  agentMode        "dedicated" | "unified"
  initialPrimary   Hive primary role, for example "architect-planner"
  primaryTransitions [{ "from": <role>, "to": <role> }]
  agentModels      { <non-primary role>: { "model": "openai/<model>", "variant": <string|null> } }   (optional)
  repository       directory of regular UTF-8 files to copy into the disposable project (not .hive/agent-hive.override.json,
                   which would replace the models chosen here)
  prompt           file holding the initial prompt
  brief            file holding an optional brief appended to the initial prompt (optional)
  skills           { <name>: <file> } project-owned skill text (optional)
  dependencies     [{ "command": "npm-ci", "directory": <relative dir with package-lock.json> }] (optional)
  artifacts        [relative path, or directory prefix ending in "/"] that inspect may export`,
  start: `start --run <run dir> --authorization <authorization.json> --budget-seconds <61..1800>

Named live run. Requires a prepared record with passing qualification. Checks that the container's guard and driver
read one clock, then reads the host OpenCode auth file once, access-only; refuses unless its expiry covers the budget
plus the host refresh window plus 600 s. Arms one non-extendable deadline, injects the credential, validates the actual
model, variant and agent catalogs, creates the primary session and submits the initial prompt.

authorization.json (schema "ic-exercise-authorization/v1"):
  runId, preparedSha256, host, model { ref, variant }, budgetSeconds (equal to --budget-seconds),
  allowedActions [${ACTIONS.join(', ')}], stopConditions [string], authorizedBy string`,
  turn: `turn --run <run dir> --operation <operation.json>

One supervisor action. operation.json (schema "ic-exercise-operation/v1"):
  id          supervisor operation ID, [A-Za-z0-9._-]{1,64}, unique in the run
  runId       the run ID
  sessionId   the primary session ID from start
  action      one of: ${ACTIONS.join(', ')}
  prompt:          { "text": string }
  reply:           { "requestId": <pending question ID>, "answers": [[label, ...], ...] }  one array per question; a label
                   is an entry of the question's released "options", and its description is in "optionDescriptions"
  permission:      { "requestId": <pending permission ID>, "decision": "once" | "reject" }
  interrupt:       {}
  approve-plan:    { "project": "${PROJECT_ROOT}", "feature": string, "revision": string, "contentHash": string,
                     "permittedWork": string }  from inspect's plan read of the current revision; the primary must have
                     called hive_plan_read directly (not through Code Mode execute) with that feature named
  switch-primary:  { "to": <role allowed by request.primaryTransitions> }
A reply, or a "once" decision, on a pending interaction that inspect does not report as complete is refused unsent
(request_incomplete); "reject" is still accepted.
New work is refused in the final 60 s; an interrupt is admitted until 5 s before the deadline. Both cutoffs are checked
again inside the container immediately before the request is sent. An operation whose text, answers or ID contains the
run's token, a fragment of it or a token-shaped string is refused before anything is recorded or sent. An unknown
outcome is never retried automatically. inspect "resolve" settles it only from native evidence that names the
operation: the prompt's message ID, the exact answers of a question reply in the session that asked, the target agent
of a v2 switch. A lost permission decision or interrupt cannot be resolved (the native API records neither): stop the
run.`,
  inspect: `inspect --run <run dir> [--request <inspection.json>]

Bounded, scanned observation. Without --request: lifecycle, guard, pending interactions and quiescence. A pending
interaction is released within fixed bounds and states whether it is complete; clipped or omitted text, choices, choice
descriptions and resources carry their original sizes, and a reply or "once" decision on an incomplete one is refused.
inspection.json (schema "ic-exercise-inspection/v1"):
  runId
  resolve        operation ID whose outcome is unknown (optional)
  conversation   { "messagesPerPage": <=100, "pages": <=10 } (optional)
  plan           { "feature": string } candidate-core read and the primary's latest plugin read of that feature, which
                 counts only when the primary called hive_plan_read directly with that feature named (optional)
  artifacts      [relative path] within request.artifacts, no link along the path (optional, at most 32 files of 64 KiB)
  list           [directory prefix ending in "/"] within request.artifacts, no link along the prefix: regular file names
                 and sizes, at most 1000 entries, links, hardlinks, native stores and excluded trees counted not listed
                 (optional)
  diff           true: line diffs of the requested artifacts against the snapshot (optional)
Never runs project commands or tests.`,
  stop: `stop --run <run dir>

Credential-independent cleanup: removes every owned container and network by exact ID on the bound engine and
confirms absence, including those of the qualification runs prepare registered inside the prepared run. Also settles
an interrupted prepare from the cleanup binding it recorded before creating anything (busy while that process still
runs); that binding is cleanup ownership only and never makes a run startable. Exports nothing. Reports
cleanup_confirmed, cleanup_present or cleanup_unknown. A create whose response was lost stays unknown until the
resource carrying its nonce is found and removed; an empty listing does not settle it, and a qualification run whose
ownership cannot be shown is unknown too. Retry stop only.`,
};

export function parseExerciseCli(argv) {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h' || command === undefined) {
    const topic = rest[0] ?? 'overview';
    if (!(topic in USAGE)) throw new HarnessError('help_topic_unknown');
    return { command: 'help', topic };
  }
  const options = {
    prepare: { 'candidate-ref': { type: 'string' }, host: { type: 'string' }, input: { type: 'string' }, 'run-id': { type: 'string' }, 'output-root': { type: 'string' }, 'docker-endpoint': { type: 'string' } },
    start: { run: { type: 'string' }, authorization: { type: 'string' }, 'budget-seconds': { type: 'string' } },
    turn: { run: { type: 'string' }, operation: { type: 'string' } },
    inspect: { run: { type: 'string' }, request: { type: 'string' } },
    stop: { run: { type: 'string' } },
  }[command];
  if (!options) throw new HarnessError('command_unknown');
  let values;
  try {
    ({ values } = parseArgs({ args: rest, strict: true, options }));
  } catch {
    throw new HarnessError('arguments_invalid');
  }
  for (const key of Object.keys(options)) {
    if (values[key] === undefined && !['request', 'docker-endpoint'].includes(key)) throw new HarnessError('argument_missing', key);
  }
  if (command === 'prepare') {
    if (!/^[0-9a-f]{40}$/.test(values['candidate-ref'])) throw new HarnessError('candidate_ref_not_full_commit');
    if (!HOST_IDS.includes(values.host)) throw new HarnessError('host_invalid');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(values['run-id'])) throw new HarnessError('run_id_invalid');
    if (!isAbsolute(values['output-root'])) throw new HarnessError('output_root_invalid');
    if (!isAbsolute(values.input)) values.input = resolve(values.input);
  } else {
    values.run = resolve(values.run);
  }
  if (command === 'start') {
    const budget = Number(values['budget-seconds']);
    if (!Number.isInteger(budget) || budget < LIVE_MIN_SECONDS || budget > LIVE_MAX_SECONDS) throw new HarnessError('budget_invalid');
    values.budgetSeconds = budget;
  }
  values.endpoint = values['docker-endpoint'] ?? 'unix:///var/run/docker.sock';
  return { command, options: values };
}

// -----------------------------------------------------------------------------------------------------------------
// Inputs and snapshots

const ROLE_SET = new Set(HIVE_ROLES);
const RELATIVE_FILE = /^(?!\/)[A-Za-z0-9._@+\- /]{1,512}$/;
const EXCLUDED_NAMES = new Set(['.git', 'node_modules', 'auth.json', '.env', '.npmrc', 'opencode.json', 'opencode.jsonc', '.opencode']);
/**
 * The one project-local Agent Hive configuration file hive-core's ConfigService reads. It is applied over the global
 * agent model and variant choices, so an imported copy would replace the models the request names and the
 * authorization covers. `request.agentModels` is the only way to choose them.
 */
const PROJECT_AGENT_OVERRIDE = '.hive/agent-hive.override.json';

function strictObject(value, allowed, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HarnessError(code);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new HarnessError(code, key);
  return value;
}

function boundedText(value, max, code) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > max) throw new HarnessError(code);
  return value;
}

function textList(value, code) {
  if (!Array.isArray(value) || value.length === 0 || value.length > INPUT_LIMITS.listItems) throw new HarnessError(code);
  return value.map((item) => boundedText(item, INPUT_LIMITS.itemChars, code));
}

function modelChoice(value, code) {
  strictObject(value, ['ref', 'variant', 'model'], code);
  const ref = value.ref ?? value.model;
  if (typeof ref !== 'string' || !/^openai\/[A-Za-z0-9._:-]{1,128}$/.test(ref)) throw new HarnessError(code);
  splitModelRef(ref);
  if (value.variant !== null && value.variant !== undefined && (typeof value.variant !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(value.variant))) throw new HarnessError(code);
  return { ref, variant: value.variant ?? null };
}

/** A normalized project-relative path, or a refusal: no absolute path, escape, empty segment or excluded name. */
export function projectPath(path, code = 'path_invalid') {
  if (typeof path !== 'string' || !RELATIVE_FILE.test(path)) throw new HarnessError(code);
  const parts = path.split('/');
  const isPrefix = path.endsWith('/');
  if (isPrefix) parts.pop();
  if (parts.some((p) => p === '' || p === '.' || p === '..' || EXCLUDED_NAMES.has(p))) throw new HarnessError(code);
  if (parts.join('/') === PROJECT_AGENT_OVERRIDE) throw new HarnessError(code);
  if (nativeStorePath(path)) throw new HarnessError(code);
  return path;
}

/** Validates request.json strictly. Configuration accepts only agent mode, model and variant choices and skill text. */
export function validateRequest(value) {
  const allowed = ['schema', 'question', 'observables', 'stopConditions', 'model', 'agentMode', 'initialPrimary', 'primaryTransitions', 'agentModels', 'repository', 'prompt', 'brief', 'skills', 'dependencies', 'artifacts'];
  strictObject(value, allowed, 'request_invalid');
  if (value.schema !== 'ic-exercise-request/v1') throw new HarnessError('request_schema_unknown');
  const primaries = new Set(['hive-master', 'architect-planner', 'swarm-orchestrator', 'hive-builder']);
  if (!['dedicated', 'unified'].includes(value.agentMode)) throw new HarnessError('request_invalid', 'agentMode');
  if (!primaries.has(value.initialPrimary)) throw new HarnessError('request_invalid', 'initialPrimary');
  const transitions = (value.primaryTransitions ?? []).map((t) => {
    strictObject(t, ['from', 'to'], 'request_invalid');
    if (!primaries.has(t.from) || !primaries.has(t.to) || t.from === t.to) throw new HarnessError('request_invalid', 'primaryTransitions');
    return { from: t.from, to: t.to };
  });
  const primaryRoles = new Set([value.initialPrimary, ...transitions.map((t) => t.to)]);
  const agentModels = {};
  for (const [role, choice] of Object.entries(strictObject(value.agentModels ?? {}, [...ROLE_SET], 'request_invalid'))) {
    // A primary runs on the session's selected model; overrides apply to the roles it delegates to.
    if (primaryRoles.has(role)) throw new HarnessError('request_invalid', 'agentModels_primary');
    const c = modelChoice(choice, 'request_invalid');
    agentModels[role] = { model: c.ref, variant: c.variant };
  }
  const skills = strictObject(value.skills ?? {}, Object.keys(value.skills ?? {}), 'request_invalid');
  for (const name of Object.keys(skills)) if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new HarnessError('request_invalid', 'skills');
  const dependencies = (value.dependencies ?? []).map((d) => {
    strictObject(d, ['command', 'directory'], 'request_invalid');
    if (d.command !== 'npm-ci') throw new HarnessError('request_invalid', 'dependencies');
    if (d.directory !== '.') projectPath(d.directory, 'request_invalid');
    return { command: 'npm-ci', directory: d.directory };
  });
  if (dependencies.length > 4) throw new HarnessError('request_invalid', 'dependencies');
  const artifacts = (value.artifacts ?? []).map((a) => projectPath(a, 'request_invalid'));
  if (artifacts.length > 64) throw new HarnessError('request_invalid', 'artifacts');
  for (const key of ['repository', 'prompt']) if (typeof value[key] !== 'string') throw new HarnessError('request_invalid', key);
  return {
    schema: value.schema, question: boundedText(value.question, 4096, 'request_invalid'), observables: textList(value.observables, 'request_invalid'),
    stopConditions: textList(value.stopConditions, 'request_invalid'), model: modelChoice(value.model, 'request_invalid'), agentMode: value.agentMode,
    initialPrimary: value.initialPrimary, primaryTransitions: transitions, agentModels, repository: value.repository, prompt: value.prompt,
    brief: value.brief ?? null, skills, dependencies, artifacts,
  };
}

function contained(root, path) {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..');
}

/** A regular UTF-8 file under the request directory, read once; links, hardlinks, devices and escapes are refused. */
function readInputFile(base, rel, maxBytes) {
  const abs = resolve(base, rel);
  if (!contained(base, abs) && abs !== base) throw new HarnessError('input_path_escapes');
  const stat = lstatSync(abs);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new HarnessError('input_not_regular_file');
  if (!contained(realpathSync(base), realpathSync(abs))) throw new HarnessError('input_path_escapes');
  if (stat.size > maxBytes) throw new HarnessError('input_oversize');
  const bytes = readFileSync(abs);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new HarnessError('input_not_utf8'); }
}

/**
 * Snapshots request.json and every file it names into one immutable document: the validated request, the repository
 * inventory in path order with each file's hash and content, prompt, brief and skills. Returns the document; its hash
 * binds the prepared run, and a changed snapshot is never reused.
 */
export function snapshotInputs(requestPath) {
  const base = dirname(requestPath);
  const requestText = readInputFile(base, requestPath.slice(base.length + 1), INPUT_LIMITS.requestBytes);
  let parsed;
  try { parsed = JSON.parse(requestText); } catch { throw new HarnessError('request_not_json'); }
  const request = validateRequest(parsed);
  const repoRoot = resolve(base, request.repository);
  if (!contained(base, repoRoot)) throw new HarnessError('input_path_escapes');
  const rootStat = lstatSync(repoRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new HarnessError('repository_not_directory');
  const files = [];
  let total = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = relative(repoRoot, abs).split(sep).join('/');
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) throw new HarnessError('input_link_refused', rel);
      if (stat.isDirectory()) {
        projectPath(`${rel}/`, 'input_path_refused');
        walk(abs);
        continue;
      }
      projectPath(rel, 'input_path_refused');
      if (files.length >= INPUT_LIMITS.files) throw new HarnessError('input_file_count_exceeded');
      const content = readInputFile(repoRoot, rel, INPUT_LIMITS.fileBytes);
      total += Buffer.byteLength(content);
      if (total > INPUT_LIMITS.totalBytes) throw new HarnessError('input_total_exceeded');
      files.push({ path: rel, sha256: sha256Text(content), content });
    }
  };
  walk(repoRoot);
  const text = (rel) => {
    const content = readInputFile(base, rel, INPUT_LIMITS.textBytes);
    total += Buffer.byteLength(content);
    if (total > INPUT_LIMITS.totalBytes) throw new HarnessError('input_total_exceeded');
    return content;
  };
  const prompt = text(request.prompt);
  const brief = request.brief ? text(request.brief) : null;
  const skills = Object.fromEntries(Object.entries(request.skills).map(([name, rel]) => [name, text(rel)]));
  const inventory = files.map((f) => `${f.path}\0${f.sha256}`).join('\n');
  return { schema: 'ic-exercise-snapshot/v1', request, requestSha256: sha256Text(requestText), files, inventorySha256: sha256Text(inventory), prompt, brief, skills };
}

/** Validates authorization.json against the prepared record and the requested budget. */
export function validateAuthorization(value, { runId, preparedSha256, prepared, budgetSeconds }) {
  strictObject(value, ['schema', 'runId', 'preparedSha256', 'host', 'model', 'budgetSeconds', 'allowedActions', 'stopConditions', 'authorizedBy'], 'authorization_invalid');
  if (value.schema !== 'ic-exercise-authorization/v1') throw new HarnessError('authorization_invalid', 'schema');
  if (value.runId !== runId) throw new HarnessError('authorization_mismatch', 'runId');
  if (value.preparedSha256 !== preparedSha256) throw new HarnessError('authorization_mismatch', 'preparedSha256');
  if (value.host !== prepared.host) throw new HarnessError('authorization_mismatch', 'host');
  const model = modelChoice(value.model, 'authorization_invalid');
  if (model.ref !== prepared.request.model.ref || model.variant !== prepared.request.model.variant) throw new HarnessError('authorization_mismatch', 'model');
  if (value.budgetSeconds !== budgetSeconds) throw new HarnessError('authorization_mismatch', 'budgetSeconds');
  if (!Array.isArray(value.allowedActions) || value.allowedActions.some((a) => !ACTIONS.includes(a)) || new Set(value.allowedActions).size !== value.allowedActions.length) throw new HarnessError('authorization_invalid', 'allowedActions');
  return { ...value, model, stopConditions: textList(value.stopConditions, 'authorization_invalid'), authorizedBy: boundedText(value.authorizedBy, 200, 'authorization_invalid') };
}

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NATIVE_ID = /^[A-Za-z0-9_]{1,128}$/;

/** Validates operation.json against the run's identities and authority. Never derives authority from model text. */
export function validateOperation(value, { runId, sessionId, allowedActions }) {
  const byAction = {
    prompt: ['text'], reply: ['requestId', 'answers'], permission: ['requestId', 'decision'], interrupt: [],
    'approve-plan': ['project', 'feature', 'revision', 'contentHash', 'permittedWork'], 'switch-primary': ['to'],
  };
  if (!value || typeof value !== 'object' || !(value.action in byAction)) throw new HarnessError('operation_invalid', 'action');
  strictObject(value, ['schema', 'id', 'runId', 'sessionId', 'action', ...byAction[value.action]], 'operation_invalid');
  if (value.schema !== 'ic-exercise-operation/v1') throw new HarnessError('operation_invalid', 'schema');
  if (typeof value.id !== 'string' || !OPERATION_ID.test(value.id)) throw new HarnessError('operation_invalid', 'id');
  if (value.runId !== runId) throw new HarnessError('operation_mismatch', 'runId');
  if (value.sessionId !== sessionId) throw new HarnessError('operation_mismatch', 'sessionId');
  if (!allowedActions.includes(value.action)) throw new HarnessError('operation_not_authorized', value.action);
  switch (value.action) {
    case 'prompt': boundedText(value.text, INPUT_LIMITS.textBytes, 'operation_invalid'); break;
    case 'reply':
      if (typeof value.requestId !== 'string' || !NATIVE_ID.test(value.requestId)) throw new HarnessError('operation_invalid', 'requestId');
      if (!Array.isArray(value.answers) || value.answers.length === 0 || value.answers.length > 16 || value.answers.some((a) => !Array.isArray(a) || a.length === 0 || a.length > 32 || a.some((x) => typeof x !== 'string' || x.length === 0 || x.length > 1000))) throw new HarnessError('operation_invalid', 'answers');
      break;
    case 'permission':
      if (typeof value.requestId !== 'string' || !NATIVE_ID.test(value.requestId)) throw new HarnessError('operation_invalid', 'requestId');
      if (!['once', 'reject'].includes(value.decision)) throw new HarnessError('operation_invalid', 'decision');
      break;
    case 'approve-plan':
      if (value.project !== PROJECT_ROOT) throw new HarnessError('operation_mismatch', 'project');
      if (typeof value.feature !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.feature)) throw new HarnessError('operation_invalid', 'feature');
      if (typeof value.revision !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(value.revision)) throw new HarnessError('operation_invalid', 'revision');
      if (typeof value.contentHash !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(value.contentHash)) throw new HarnessError('operation_invalid', 'contentHash');
      boundedText(value.permittedWork, 4096, 'operation_invalid');
      break;
    case 'switch-primary':
      if (typeof value.to !== 'string' || !ROLE_SET.has(value.to)) throw new HarnessError('operation_invalid', 'to');
      break;
    default:
      break;
  }
  return value;
}

/** Validates inspection.json; artifact and list paths must fall inside the request's artifact allowlist. */
export function validateInspection(value, { runId, artifacts }) {
  strictObject(value, ['schema', 'runId', 'resolve', 'conversation', 'plan', 'artifacts', 'list', 'diff'], 'inspection_invalid');
  if (value.schema !== 'ic-exercise-inspection/v1') throw new HarnessError('inspection_invalid', 'schema');
  if (value.runId !== runId) throw new HarnessError('inspection_mismatch', 'runId');
  if (value.resolve !== undefined && (typeof value.resolve !== 'string' || !OPERATION_ID.test(value.resolve))) throw new HarnessError('inspection_invalid', 'resolve');
  if (value.conversation !== undefined) {
    strictObject(value.conversation, ['messagesPerPage', 'pages'], 'inspection_invalid');
    const { messagesPerPage = 100, pages = 10 } = value.conversation;
    if (!Number.isInteger(messagesPerPage) || messagesPerPage < 1 || messagesPerPage > 100 || !Number.isInteger(pages) || pages < 1 || pages > 10) throw new HarnessError('inspection_cap_exceeded');
  }
  if (value.plan !== undefined) {
    strictObject(value.plan, ['feature'], 'inspection_invalid');
    if (typeof value.plan.feature !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.plan.feature)) throw new HarnessError('inspection_invalid', 'plan');
  }
  const allowedPath = (p) => artifacts.some((a) => a === p || (a.endsWith('/') && p.startsWith(a)));
  for (const key of ['artifacts', 'list']) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].length > 32) throw new HarnessError('inspection_cap_exceeded');
    for (const p of value[key]) {
      projectPath(p, 'inspection_path_invalid');
      if (key === 'list' && !p.endsWith('/')) throw new HarnessError('inspection_path_invalid');
      if (!allowedPath(p)) throw new HarnessError('inspection_path_not_allowed');
    }
  }
  if (value.diff !== undefined && typeof value.diff !== 'boolean') throw new HarnessError('inspection_invalid', 'diff');
  return value;
}

// -----------------------------------------------------------------------------------------------------------------
// Driver replies. Nothing the container prints is trusted for its shape: a reply is rebuilt from the allowlisted fields
// below, each checked for type, pattern and bound, and any deviation rejects the whole reply. Failure, refusal and
// reason words come from fixed sets, not from any string that merely looks safe.

const INVALID = Symbol('invalid');
const SESSION = /^ses_[A-Za-z0-9]{1,64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@+/-]{0,199}$/;
const SAFE_WORD = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;

const TREE_FAILURES = ['root_unreadable', 'children_page_cap', 'children_unreadable', 'children_malformed', 'parent_link_unproven', 'session_cap', 'children_cursor_malformed', 'cap'];
const HISTORY_FAILURES = ['history_oversize', 'history_unreadable', 'history_malformed', 'unread'];
const PLAN_FAILURES = ['feature_name_invalid', 'core_unavailable', 'feature_path_escapes', 'plan_not_regular', 'plan_oversize', 'plan_missing', 'plan_input_rejected', 'plan_input_oversize', 'plan_read_failed'];
const REFUSALS = [
  'not_quiescent', 'plan_changed', 'plugin_read_not_current', 'plan_read_parity_failed', 'approval_not_observed', 'approval_revision_unknown', 'plan_not_approved',
  'session_agent_unexpected', 'request_not_pending', 'request_incomplete', 'answers_invalid', 'decision_invalid', 'deadline_exceeded', ...PLAN_FAILURES,
];
/** Every failure word the driver can print. A drift test compares this set with the driver's own literals. */
export const DRIVER_FAILURES = new Set([
  'native_auth_changed', 'export_oversize', 'evidence_contaminated', 'scanner_unavailable', 'path_rejected', 'input_file_rejected', 'git_failed', 'input_skill_rejected',
  'dependency_rejected', 'dependency_setup_failed', 'host_not_ready', 'instance_not_ready', 'auth_payload_malformed', 'session_create_refused', 'session_create_unknown',
  'operation_kind_invalid', 'comment_seed_ineffective', 'unknown_command', 'input_malformed', 'driver_exception', 'deadline_exceeded',
  ...TREE_FAILURES, ...HISTORY_FAILURES, ...PLAN_FAILURES,
]);
export const DRIVER_REFUSALS = new Set(REFUSALS);
const EFFECTS = ['accepted'];
const REASON = new RegExp(`^(tree_incomplete:(${TREE_FAILURES.join('|')})|tree_changed|status_unknown|interactions_unknown|(session_busy|session_busy_outside_tree|history_incomplete|tool_running):ses_[A-Za-z0-9]{1,64}|(pending_question|pending_permission|pending_outside_tree):[A-Za-z0-9_.:-]{1,200})$`);

const str = (max) => (v) => (typeof v === 'string' && v.length <= max ? v : INVALID);
const match = (re, max = 256) => (v) => (typeof v === 'string' && v.length <= max && re.test(v) ? v : INVALID);
const oneOf = (words) => { const set = new Set(words); return (v) => (set.has(v) ? v : INVALID); };
const bool = (v) => (typeof v === 'boolean' ? v : INVALID);
const exactly = (value) => (v) => (v === value ? v : INVALID);
const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : INVALID);
const anyInt = (v) => (Number.isSafeInteger(v) ? v : INVALID);
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : INVALID);
const nullable = (f) => (v) => (v === null ? null : f(v));
const opt = (f) => ({ optional: f });
const arr = (f, max) => (v) => {
  if (!Array.isArray(v) || v.length > max) return INVALID;
  const out = [];
  for (const item of v) {
    const checked = f(item);
    if (checked === INVALID) return INVALID;
    out.push(checked);
  }
  return out;
};
const obj = (shape) => (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return INVALID;
  const out = {};
  for (const [key, spec] of Object.entries(shape)) {
    const f = typeof spec === 'function' ? spec : spec.optional;
    if (v[key] === undefined) {
      if (typeof spec === 'function') return INVALID;
      continue;
    }
    const checked = f(v[key]);
    if (checked === INVALID) return INVALID;
    out[key] = checked;
  }
  return out;
};

const textRecord = (max) => obj({ text: str(max), chars: int, clipped: bool });
const nativeName = nullable(match(NAME, 200));
const featureName = match(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 128);
// A pending interaction carries every text's original size and every list's original count next to the bounded text, so
// a clipped or omitted part is visible to the supervisor. `complete` is the driver's claim that nothing was clipped,
// left out or unrepresentable; the host accepts that claim only when the sizes agree with the texts.
const pendingFields = obj({
  kind: oneOf(['question', 'permission']), id: match(/^[A-Za-z0-9_.:-]{1,200}$/, 200), sessionId: match(SESSION, 80), toolCallId: nullable(match(/^[A-Za-z0-9_.:-]{1,200}$/, 200)),
  outsideTree: opt(exactly(true)), complete: bool, questionCount: opt(int),
  questions: opt(arr(obj({
    key: opt(str(64)), type: opt(str(32)), question: str(2000), questionChars: int, header: nullable(str(200)), headerChars: nullable(int), multiple: bool,
    options: arr(str(300), 32), optionCount: int, optionChars: arr(int, 32), optionDescriptions: arr(str(500), 32), optionDescriptionChars: arr(int, 32),
  }), 16)),
  permission: opt(obj({ action: str(100), actionChars: int, resources: arr(str(500), 16), resourceCount: int, resourceChars: arr(int, 16) })),
});

/** The pending item when its stated sizes are honest and agree with any claim of completeness, otherwise INVALID. */
function pendingItem(value) {
  const item = pendingFields(value);
  if (item === INVALID) return INVALID;
  let whole = true;
  // A stated size may exceed the text it accompanies (clipped) but never fall short of it.
  const sized = (text, chars) => {
    whole = whole && chars === text.length;
    return chars >= text.length;
  };
  if ((item.questions === undefined) !== (item.questionCount === undefined)) return INVALID;
  if (item.questions) {
    if (item.questionCount < item.questions.length) return INVALID;
    whole = item.questionCount === item.questions.length;
    for (const q of item.questions) {
      if (!sized(q.question, q.questionChars)) return INVALID;
      if ((q.header === null) !== (q.headerChars === null) || (q.header !== null && !sized(q.header, q.headerChars))) return INVALID;
      if (q.optionCount < q.options.length || q.optionChars.length !== q.options.length) return INVALID;
      if (q.optionDescriptions.length !== q.options.length || q.optionDescriptionChars.length !== q.options.length) return INVALID;
      whole = whole && q.optionCount === q.options.length;
      if (!q.options.every((option, i) => sized(option, q.optionChars[i]))) return INVALID;
      if (!q.optionDescriptions.every((description, i) => sized(description, q.optionDescriptionChars[i]))) return INVALID;
    }
  }
  if (item.permission) {
    const p = item.permission;
    if (!sized(p.action, p.actionChars) || p.resourceCount < p.resources.length || p.resourceChars.length !== p.resources.length) return INVALID;
    whole = whole && p.resourceCount === p.resources.length;
    if (!p.resources.every((resource, i) => sized(resource, p.resourceChars[i]))) return INVALID;
  }
  return item.complete && !whole ? INVALID : item;
}
const toolRecord = obj({
  id: nullable(match(/^[A-Za-z0-9_.:-]{1,200}$/, 200)), name: match(SAFE_WORD, 80), status: nullable(match(SAFE_WORD, 80)),
  agent: opt(nativeName), childSessionId: opt(nullable(match(SESSION, 80))), prompt: opt(textRecord(4000)), command: opt(textRecord(1000)), exit: opt(nullable(anyInt)),
  args: opt(textRecord(2000)), path: opt(textRecord(500)), questions: opt(textRecord(4000)), answers: opt(textRecord(2000)),
  result: opt(nullable(obj({
    success: nullable(bool), approval: nullable(obj({ success: nullable(bool), reason: nullable(match(SAFE_WORD, 80)), revision: nullable(str(200)) })),
    sync: nullable(obj({ success: nullable(bool) })), revision: nullable(str(200)),
  }))),
});
const turn = obj({
  id: match(/^[A-Za-z0-9_.:-]{1,200}$/, 200), role: match(NAME, 200), agent: nativeName,
  model: nullable(obj({ providerID: nativeName, modelID: nativeName, variant: nativeName })), error: nullable(str(40)),
  text: str(16 * 1024), chars: int, clipped: bool, tools: arr(toolRecord, 2000),
});
const conversation = obj({
  sessions: arr(obj({
    id: match(SESSION, 80), parentId: nullable(match(SESSION, 80)), agent: nativeName, historyComplete: bool, historyFailure: nullable(oneOf(HISTORY_FAILURES)),
    turns: arr(turn, 1000), finalReturn: textRecord(16 * 1024),
  }), 32),
  toolRecordsCapped: bool,
});
const planReport = (v) => {
  if (v && v.ok === false) return obj({ ok: exactly(false), failure: oneOf(PLAN_FAILURES) })(v);
  return obj({
    ok: exactly(true), featurePath: str(512), planPath: str(512), revision: str(200), contentHash: str(200), status: oneOf(['planning', 'approved']),
    comments: textRecord(32 * 1024), content: textRecord(64 * 1024),
    pluginRead: nullable(obj({ sessionId: match(SESSION, 80), messageId: str(200), callId: nullable(str(200)), revision: str(200), differences: arr(oneOf(['revision', 'contentHash', 'status', 'content', 'comments']), 5) })),
  })(v);
};
const OMITTED = ['path_rejected', 'absent', 'oversize', 'not_utf8', 'diff_cap'];
const artifact = obj({ path: str(512), omitted: opt(oneOf(OMITTED)), bytes: opt(int), sha256: opt(match(/^[0-9a-f]{64}$/, 64)), text: opt(str(64 * 1024)) });
const listing = obj({
  prefix: str(512), entries: arr(obj({ path: str(512), bytes: int }), 1000), complete: bool, absent: bool, rejected: bool,
  omitted: obj({ links: int, special: int, excluded: int, names: int }),
});
const diffEntry = obj({ path: str(512), omitted: opt(oneOf(OMITTED)), diff: opt(str(256 * 1024)) });
const approvalCall = obj({
  sessionId: match(SESSION, 80), messageId: str(200), callId: nullable(str(200)), agent: nativeName, status: nullable(str(40)), feature: nullable(featureName),
  expectedRevision: nullable(str(200)), sync: bool, approvalSuccess: bool, approvalRevision: nullable(str(200)), syncSuccess: bool,
});
const reasons = arr(match(REASON, 300), 200);
const pending = nullable(arr(pendingItem, 64));
const failureReply = obj({ ok: exactly(false), failure: oneOf([...DRIVER_FAILURES]), submitted: opt(exactly(false)) });

const REPLIES = {
  setup: obj({ ok: exactly(true), dependencies: opt((v) => (Array.isArray(v) ? v.length : INVALID)) }),
  inject: obj({ ok: bool, status: nullable(anyInt), failure: opt(oneOf([...DRIVER_FAILURES])) }),
  catalog: obj({
    ok: exactly(true), agentsReadable: bool, agents: (v) => {
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length > 64) return INVALID;
      const out = {};
      for (const [key, present] of Object.entries(v)) {
        if (!HIVE_ROLES.includes(key) || typeof present !== 'boolean') return INVALID;
        out[key] = present;
      }
      return out;
    },
    choices: arr(obj({ ref: match(/^openai\/[A-Za-z0-9._:-]{1,128}$|^mock\/[A-Za-z0-9._:-]{1,128}$/, 160), listed: bool, toolCall: bool, variantListed: nullable(bool) }), 64),
  }),
  'create-session': obj({ ok: exactly(true), sessionId: match(SESSION, 80) }),
  clock: obj({ ok: exactly(true), clockMs: finite, processMs: finite }),
  'qualification-prompt': obj({ ok: exactly(true), text: str(64 * 1024) }),
  'seed-comments': obj({ ok: exactly(true), revision: str(200) }),
  submit: obj({
    ok: exactly(true), submitted: bool, acknowledged: opt(nullable(bool)), status: opt(nullable(anyInt)), local: opt(exactly(true)), refused: opt(oneOf(REFUSALS)), reasons: opt(reasons),
    pending: opt(pending), currentRevision: opt(str(200)), ownerSessionId: opt(match(SESSION, 80)), toolCallId: opt(nullable(match(/^[A-Za-z0-9_.:-]{1,200}$/, 200))),
  }),
  observe: obj({
    ok: exactly(true),
    tree: obj({ sessions: arr(obj({ id: match(SESSION, 80), parentId: nullable(match(SESSION, 80)), agent: nativeName }), 32), complete: bool, failure: nullable(oneOf(TREE_FAILURES)) }),
    busy: nullable(arr(match(SESSION, 80), 32)), pending, quiescent: bool, reasons, approvals: arr(approvalCall, 64),
    resolution: opt(obj({ resolved: bool, effect: opt(oneOf(EFFECTS)) })), conversation: opt(conversation), plan: opt(planReport),
    artifacts: opt(arr(artifact, 32)), list: opt(arr(listing, 32)), diff: opt(arr(diffEntry, 64)),
  }),
};

/**
 * The validated, rebuilt form of one driver reply, or null. A well-formed failure reply is accepted for every command.
 * Unknown fields are dropped; a wrong type, pattern, bound or word rejects the reply.
 */
export function parseDriverReply(command, value) {
  if (value && value.ok === false) {
    const failed = failureReply(value);
    return failed === INVALID ? null : failed;
  }
  const schema = REPLIES[command];
  const checked = schema ? schema(value) : INVALID;
  return checked === INVALID ? null : checked;
}

// -----------------------------------------------------------------------------------------------------------------
// Run state. Every lifecycle fact is an immutable record; the current state is derived, never rewritten.

/** The run's lifecycle from its records: start progress, primary, operations and whether any is unresolved. */
export function runState(journal) {
  const names = journal.names();
  const read = (name) => journal.read(name)?.value ?? null;
  const ops = names.filter((n) => /^op\.\d{4}\.intent$/.test(n)).map((n) => {
    const seq = n.slice(3, 7);
    const intent = read(n);
    const outcome = read(`op.${seq}.outcome`);
    const resolution = read(`op.${seq}.resolution`);
    let state = outcome?.state ?? 'unknown';
    if (state === 'unknown' && resolution?.resolved) state = resolution.effect === 'not_applied' ? 'not_applied' : 'resolved';
    return { seq, intent, outcome, resolution, state };
  });
  let primary = read('start.session')?.agent ?? null;
  for (const op of ops) if (op.intent.kind === 'switch' && ['acknowledged', 'resolved'].includes(op.state)) primary = op.intent.agent;
  const approvals = ops.filter((op) => op.intent.plan && ['acknowledged', 'resolved'].includes(op.state)).map((op) => ({ ...op.intent.plan, operationId: op.intent.id, messageId: op.intent.messageId }));
  return {
    prepared: journal.read('prepared'),
    authorization: read('authorization'),
    armed: read('start.armed'),
    trusted: names.includes('start.inject'),
    session: read('start.session'),
    started: read('start.result'),
    latch: read('latch'),
    stopped: names.filter((n) => /^stop\.\d{4}$/.test(n)).map(read),
    primary,
    ops,
    unresolved: ops.filter((op) => op.state === 'unknown').map((op) => op.intent.id),
    lastApproval: approvals.at(-1) ?? null,
    next: (prefix) => `${prefix}.${String(names.filter((n) => n.startsWith(`${prefix}.`) && /\.\d{4}(\.|$)/.test(n.slice(prefix.length))).map((n) => n.slice(prefix.length + 1, prefix.length + 5)).filter((x, i, a) => a.indexOf(x) === i).length + 1).padStart(4, '0')}`,
  };
}

/** Admission of new work: never in the final NO_NEW_WORK_MS of the guard's deadline. */
export function admitsNewWork(guardRemainingMs) {
  return Number.isFinite(guardRemainingMs) && guardRemainingMs > NO_NEW_WORK_MS;
}

/**
 * Admission of one action against the guard's remaining lifetime, read immediately before its effect. An interrupt is
 * the only action admitted in the final window, until INTERRUPT_FLOOR_MS before the hard stop; everything else needs
 * the no-new-work reserve.
 */
export function admitsAction(action, guardRemainingMs) {
  if (!Number.isFinite(guardRemainingMs)) return false;
  return action === 'interrupt' ? guardRemainingMs > INTERRUPT_FLOOR_MS : admitsNewWork(guardRemainingMs);
}

/** Remaining credential lifetime the next operation needs: guard lifetime + exact host refresh window + 600 s. */
export function operationLifetimeMs(host, guardRemainingMs) {
  return requiredLifetimeMs(host, guardRemainingMs, LIFETIME_MARGIN_MS);
}

// -----------------------------------------------------------------------------------------------------------------
// Container control

/** This process's monotonic clock. Command budgets never follow the wall clock, which may move either way. */
const hostClock = () => performance.now();

/** A command budget: everything a command does receives what is left, not a fresh timeout per step. */
export function deadline(ms, now = hostClock) {
  const end = now() + ms;
  return { end, left: () => Math.max(0, end - now()) };
}

/** A locked command's budget counts from when the command started waiting for the lock (`startedAt`, `hostClock`). */
function commandBudget(ms, deps) {
  const startedAt = typeof deps.startedAt === 'number' && Number.isFinite(deps.startedAt) ? deps.startedAt : hostClock();
  const end = startedAt + ms;
  return { end, left: () => Math.max(0, end - hostClock()) };
}

function lastJsonLine(stdout) {
  try { return JSON.parse(stdout.trim().split('\n').at(-1) ?? ''); } catch { return null; }
}

/** Taken off a translated command cutoff, so the driver stops before the host's own budget ends. */
export const CLOCK_MARGIN_MS = 2_000;

/**
 * A driver's cutoffs on the container's shared clock, from one guard reading (`sync`): the guard's clock value
 * `guardClockMs` and deadline `deadlineClockMs`, and `hostMs`, this process's clock just after the reply arrived. The
 * guard read its clock before `hostMs`, so `guardClockMs + (budgetEnd - hostMs)` is never later than the container
 * instant at which the host's budget ends: latency only makes the cutoff earlier. `reserveMs` gives the effect cutoff,
 * the guard deadline less the action's reserve. The two clocks are never assumed to share an origin.
 */
export function containerCutoffs(sync, budgetEnd, reserveMs) {
  const commandEndClock = sync.guardClockMs + (budgetEnd - sync.hostMs) - CLOCK_MARGIN_MS;
  return reserveMs === undefined ? { commandEndClock } : { commandEndClock, actionEndClock: sync.deadlineClockMs - reserveMs };
}

/** The reserve an action keeps before the guard deadline: an interrupt until 5 s before, all new work 60 s. */
export function actionReserveMs(action) {
  return action === 'interrupt' ? INTERRUPT_FLOOR_MS : NO_NEW_WORK_MS;
}

/** Whether a driver's reading of the shared clock lies between two guard readings, so both read one clock. */
export function sharedClockBracket(before, reading, after) {
  return [before, reading, after].every((v) => typeof v === 'number' && Number.isFinite(v)) && before <= reading && reading <= after;
}

/**
 * Runs one driver command with its input on stdin. The driver receives absolute cutoffs on the container's shared
 * clock (`containerCutoffs`): the command cutoff always, the effect cutoff when `reserveMs` names the action's reserve.
 * A delayed `docker exec` start therefore gets no fresh budget, and the driver checks both cutoffs again immediately
 * before any request it sends. The reply is scanned on the host as raw text and again once decoded (so a token that
 * arrived as escape sequences is found), then rebuilt through `parseDriverReply`; a contaminated or malformed reply is
 * never returned. `notSent` means no driver ran, so nothing was sent. `timedOut` replies are unknown: killing a Docker
 * client does not prove the in-container process stopped.
 */
async function driver(ctx, command, input, budget, { reserveMs } = {}) {
  if (budget.left() <= 0) return { value: null, timedOut: false, contaminated: false, invalid: false, notSent: 'deadline_exceeded' };
  if (!ctx.sync) await guardCall(ctx, ['status'], budget);
  const left = budget.left();
  if (!ctx.sync) return { value: null, timedOut: false, contaminated: false, invalid: false, notSent: 'clock_unavailable' };
  if (left <= 0) return { value: null, timedOut: false, contaminated: false, invalid: false, notSent: 'deadline_exceeded' };
  const body = { ...input, host: ctx.host, trusted: ctx.trusted, expected: ctx.expected ?? null, ...containerCutoffs(ctx.sync, budget.end, reserveMs) };
  const result = await ctx.docker.run(['exec', '-i', '--user', AGENT_USER, ctx.containerId, 'node', DRIVER, command], { input: JSON.stringify(body), timeoutMs: left });
  return interpretReply(ctx.scan, command, result);
}

/** A driver exec result as the host will use it: scanned raw and decoded, shape-validated, or marked contaminated. */
export function interpretReply(scan, command, result) {
  if (scan(result.stdout)) return { value: null, timedOut: result.timedOut, contaminated: true, invalid: false };
  const parsed = lastJsonLine(result.stdout);
  if (parsed !== null && scanValue(scan, parsed)) return { value: null, timedOut: result.timedOut, contaminated: true, invalid: false };
  const value = parsed === null ? null : parseDriverReply(command, parsed);
  return { value, timedOut: result.timedOut, contaminated: false, invalid: parsed !== null && value === null };
}

/**
 * One guard command. A reply carrying the guard's clock and deadline becomes the command's clock reading (`ctx.sync`),
 * paired with this process's clock taken after the reply arrived (see `containerCutoffs`).
 */
async function guardCall(ctx, args, budget, { user = GUARD_USER, input } = {}) {
  const left = Math.min(30_000, budget.left());
  if (left <= 0) return null;
  const result = await ctx.docker.run(['exec', ...(input === undefined ? [] : ['-i']), '--user', user, ctx.containerId, 'node', GUARD, ...args], { input, timeoutMs: left });
  const hostMs = hostClock();
  const reply = lastJsonLine(result.stdout);
  if (user === GUARD_USER && reply?.ok === true && Number.isFinite(reply.clockMs) && Number.isFinite(reply.deadlineClockMs)) {
    ctx.sync = { guardClockMs: reply.clockMs, deadlineClockMs: reply.deadlineClockMs, hostMs };
  }
  return reply;
}

/** Creates, starts and checks one exercise container; the guard must be unarmed and isolation verified. */
async function openContainer(ctx, { network, ceilingSeconds }, budget) {
  const id = await ctx.resources.create('container', (labels) => containerCreateArgs({
    image: ctx.imageId, labels, network, password: randomBytes(24).toString('hex'), ceilingSeconds,
  }));
  ctx.containerId = id;
  const started = await ctx.docker.run(['start', id], { timeoutMs: Math.min(60_000, budget.left()) });
  if (started.code !== 0) throw new HarnessError('container_start_failed');
  const status = await guardCall(ctx, ['status'], budget);
  if (!status?.ok || status.armed || status.bound) throw new HarnessError('guard_not_ready');
  const inspect = (await ctx.docker.json(['inspect', id], { timeoutMs: Math.min(30_000, budget.left()) }))?.[0];
  const probe = lastJsonLine((await ctx.docker.run(['exec', '--user', AGENT_USER, id, 'node', FIXTURE, 'isolation-probe', '{}'], { timeoutMs: Math.min(60_000, budget.left()) })).stdout);
  const verdict = assessContainerIsolation(inspect, probe, { network, ceilingSeconds });
  if (!verdict.ok) throw new HarnessError('isolation_check_failed', verdict.failures);
  return id;
}

/**
 * Docker client and owned-resource ledger of one run directory, bound to a command budget. `docker` replaces the CLI
 * client in synthetic tests only.
 */
function runDocker(runDir, endpoint, engineId, runId, budget, docker = new Docker({ endpoint, configDir: join(runDir, 'docker-config') })) {
  const resources = new Resources(docker, join(runDir, 'resources.jsonl'), runId, engineId, { remainingMs: budget.left, strictCreates: true });
  const { ids, nonces } = outstandingFromLedger(readFileSync(join(runDir, 'resources.jsonl'), 'utf8'));
  for (const [id, kind] of ids) resources.live.set(id, kind);
  for (const [nonce, kind] of nonces) resources.pendingCreates.set(nonce, kind);
  return { docker, resources };
}

// -----------------------------------------------------------------------------------------------------------------
// Credential continuity. The auth file is read once per check, through one descriptor, and compared in full with the
// fingerprint the guard bound at start. Only the Boolean result is kept; the fingerprint never reaches a host record.

/**
 * Acquires the access-only credential for this command and proves it is the one bound at start. Any failure latches
 * the run; a replacement token is never adopted as scanner input.
 */
async function continuity(ctx, budget, { requireLifetime = true } = {}) {
  let snapshot;
  try {
    snapshot = snapshotAuthFile(ctx.authPath);
  } catch (error) {
    return { ok: false, code: error instanceof CredentialError ? error.code : 'auth_unreadable' };
  }
  const reply = await guardCall(ctx, ['compare'], budget, { input: JSON.stringify({ fingerprint: fingerprintWire(snapshot.fingerprint) }) });
  if (!reply?.ok) return { ok: false, code: 'guard_continuity_unavailable' };
  if (reply.matches !== true) return { ok: false, code: 'host_auth_changed' };
  let selected;
  try {
    selected = credentialFromSnapshot(snapshot, { now: Date.now(), requiredMs: requireLifetime ? operationLifetimeMs(ctx.host, reply.remainingMs) : 0 });
  } catch (error) {
    return { ok: false, code: error instanceof CredentialError ? error.code : 'auth_malformed' };
  }
  return { ok: true, credential: selected.credential, guardRemainingMs: reply.remainingMs };
}

function latch(journal, code, detail = null) {
  if (journal.read('latch')) return;
  journal.write('latch', { code, detail, at: new Date().toISOString() });
}

/**
 * The last check before container-derived content leaves the host: the run's credential must still be the one bound at
 * start, and a scanner built from that exact original token (never a replacement) must find nothing in the decoded value
 * or its serialization. A failure latches the run and nothing is released.
 */
async function releaseGate(ctx, budget, value) {
  let scan = evidenceScanner(null);
  if (ctx.trusted) {
    const check = await continuity(ctx, budget, { requireLifetime: false });
    if (!check.ok) {
      latch(ctx.journal, check.code);
      return { ok: false, code: check.code };
    }
    if (!ctx.expected || check.credential.access !== ctx.expected.access) {
      latch(ctx.journal, 'host_auth_changed');
      return { ok: false, code: 'host_auth_changed' };
    }
    scan = evidenceScanner(check.credential);
  }
  if (scanValue(scan, value)) {
    latch(ctx.journal, 'evidence_contaminated');
    return { ok: false, code: 'evidence_contaminated' };
  }
  return { ok: true };
}

/**
 * A command's final status through the release gate. On failure only the controller facts the caller names are
 * published, and only if they pass a scan of their own with the original token's scanner (`ctx.scan`); otherwise the
 * fallback is the command, the fixed status and the gate's fixed reason.
 */
async function publishStatus(ctx, budget, status, controllerFacts) {
  const gate = await releaseGate(ctx, budget, status);
  if (gate.ok) return { published: true, status };
  const minimal = { command: controllerFacts.command, status: 'content_unavailable', reason: gate.code, latched: true };
  return { published: false, status: scannedStatus(ctx.scan, { ...controllerFacts, ...minimal }, minimal) };
}

/**
 * A status line as it may be printed or recorded: whole when `scan` finds nothing in it, otherwise only `minimal`,
 * which holds fixed words. Used for statuses that do not pass the release gate. No status names the run directory: a
 * caller-chosen path can carry an opaque token that only a scanner built from the exact token would find.
 */
function scannedStatus(scan, status, minimal) {
  return scanValue(scan, status) ? minimal : status;
}

// A status from a command that holds no scanner for the run's original token (prepare, the latched or stopped views of
// inspect, and stop: cleanup never reacquires the credential) is rebuilt from these allowlisted controller facts. Fixed
// words, numbers, booleans and identities the controller or the container engine issued are the only values; a field
// not named here is dropped and a value that does not fit rejects the whole status.
const ID_WORD = match(/^[A-Za-z0-9_.:-]{1,128}$/, 128);
const WORD = match(SAFE_WORD, 80);
const LIFECYCLE_FACTS = obj({
  host: oneOf(['v1', 'v2']), trusted: bool, latched: nullable(WORD),
  deadlineAt: nullable((v) => ((typeof v === 'string' && /^[0-9TZ:.+-]{1,40}$/.test(v)) || (typeof v === 'number' && Number.isFinite(v)) ? v : INVALID)),
  sessionId: nullable(match(SESSION, 80)), primary: nullable(match(NAME, 200)),
  operations: arr(obj({ id: match(OPERATION_ID, 64), kind: opt(nullable(WORD)), state: WORD }), 1000), unresolved: arr(match(OPERATION_ID, 64), 1000),
  containerId: nullable(ID_WORD), stopped: bool,
});
const CONTROLLER_STATUS = obj({
  command: oneOf(['prepare', 'inspect', 'stop']), status: WORD, reason: opt(WORD), lifecycle: opt(LIFECYCLE_FACTS),
  preparedSha256: opt(match(/^[0-9a-f]{64}$/, 64)), failures: opt(arr(WORD, 64)),
  qualification: opt(nullable(obj({ passed: int, total: int, failures: arr(WORD, 200) }))),
  retained: opt(arr(obj({ id: opt(ID_WORD), nonce: opt(ID_WORD), subrun: opt(oneOf(QUALIFICATION_SUBRUNS)), state: oneOf(['present', 'unknown']) }), 64)), retainedImages: opt(arr(ID_WORD, 64)),
});

/** The closed controller form of `status` for `command`, or fixed words when it does not fit. */
export function controllerStatus(command, status) {
  const checked = CONTROLLER_STATUS({ ...status, command });
  return checked === INVALID ? { command, status: 'content_unavailable', reason: 'status_invalid' } : checked;
}

/**
 * Whether a supervisor-written input file carries the run's token: its raw text and every decoded string, with the
 * command's scanner (the original token's once the credential is checked, token shapes before that).
 */
function inputContaminated(scan, file) {
  return scan(file.text) || scanValue(scan, file.value);
}

// -----------------------------------------------------------------------------------------------------------------
// Commands

function readJsonInput(path, max, code) {
  let text;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error('bad');
    text = readFileSync(path, 'utf8');
  } catch {
    throw new HarnessError(code);
  }
  try { return { value: JSON.parse(text), text, sha256: sha256Text(text) }; } catch { throw new HarnessError(code); }
}

/** Opens a prepared run directory for a locked command, with every binding the prepared record names re-verified. */
function openRun(runDir, env, budget, deps = {}) {
  const journal = new Journal(join(runDir, 'records'));
  const state = runState(journal);
  if (!state.prepared) throw new HarnessError('run_not_prepared');
  const prepared = state.prepared.value;
  if (prepared.status !== 'prepared') throw new HarnessError('run_not_prepared');
  const input = journal.read('input')?.value;
  if (!input || sha256File(join(runDir, 'inputs', 'snapshot.json')) !== input.snapshotSha256) throw new HarnessError('input_snapshot_changed');
  requireRecordedLock(runDir, input, deps.lock);
  const { docker, resources } = runDocker(runDir, prepared.docker.endpoint, prepared.docker.engineId, prepared.runId, budget, deps.docker);
  const ctx = {
    runDir, journal, state, prepared, preparedSha256: state.prepared.sha256, host: prepared.host, docker, resources,
    imageId: prepared.runtime.imageId, containerId: state.session?.containerId ?? journal.read('start.container')?.value?.id ?? null,
    authPath: env.IC_EXERCISE_AUTH_PATH ?? hostAuthPath(env), trusted: state.trusted, expected: null, scan: evidenceScanner(null), sync: null,
  };
  return ctx;
}

/**
 * The run's lock file is still the one prepare recorded, and the lock this command holds, when it holds one, is on that
 * same file. A replaced lock file would let a second actor lock a different inode.
 */
function requireRecordedLock(runDir, input, lock) {
  const stat = lstatSync(join(runDir, 'lock'));
  if (!stat.isFile() || String(stat.ino) !== input?.lockInode || (lock && lock.ino !== input.lockInode)) throw new HarnessError('lock_file_replaced');
}

function snapshotOf(runDir) {
  return JSON.parse(readFileSync(join(runDir, 'inputs', 'snapshot.json'), 'utf8'));
}

/**
 * Records, before the first resource effect, what a later `stop` needs to settle whatever this run created: the exact
 * engine and endpoint, the run's ID, and the identities of its ledger and lock. It is written once and only this
 * function writes it; it carries no credential, no input and no authority to start anything.
 */
export function bindCleanup(journal, runDir, { runId, endpoint, engineId }) {
  const owned = (file) => {
    const stat = lstatSync(join(runDir, file));
    if (!stat.isFile() || stat.nlink !== 1) throw new HarnessError('cleanup_binding_unowned');
    return String(stat.ino);
  };
  return journal.write(CLEANUP_BINDING, { schema: 'ic-exercise-cleanup-binding/v1', runId, endpoint, engineId, ledgerIno: owned('resources.jsonl'), lockInode: owned('lock') });
}

/**
 * Prepares a run. The run's lock is held from before anything can be created until the final record is written or this
 * process ends, so a `stop` can neither race the preparation nor find it half-owned: once the process is gone, `stop`
 * settles whatever the binding and the registered qualification runs show was created. `deps.docker` replaces the
 * Docker CLI client in synthetic tests only.
 */
export async function prepareCommand(options, env, deps = {}) {
  const budget = deadline(COMMAND_MS.prepare);
  const runDir = createRunDir(options['output-root'], options['run-id']);
  mkdirSync(join(runDir, 'docker-config'));
  writeOnce(join(runDir, 'docker-config', 'config.json'), '{}\n');
  writeOnce(join(runDir, 'resources.jsonl'), '');
  writeOnce(join(runDir, 'lock'), '');
  const journal = Journal.create(join(runDir, 'records'));
  const docker = deps.docker ?? new Docker({ endpoint: options.endpoint, configDir: join(runDir, 'docker-config') });
  const resources = new Resources(docker, join(runDir, 'resources.jsonl'), options['run-id'], null, { remainingMs: budget.left, strictCreates: true });
  const record = { schema: 'ic-exercise-prepared/v1', runId: options['run-id'], host: options.host, status: 'failed', failures: [] };
  let lock = null;
  try {
    try {
      if (flockAvailable()) {
        lock = await acquireRunLock(join(runDir, 'lock'), { waitSeconds: LOCK_WAIT_SECONDS });
        if (lock.busy) throw new HarnessError('lock_acquire_failed');
      }
      const snapshot = snapshotInputs(options.input);
      mkdirSync(join(runDir, 'inputs'));
      writeOnce(join(runDir, 'inputs', 'snapshot.json'), JSON.stringify(snapshot));
      journal.write('input', {
        snapshotSha256: sha256File(join(runDir, 'inputs', 'snapshot.json')), requestSha256: snapshot.requestSha256, inventorySha256: snapshot.inventorySha256,
        files: snapshot.files.map((f) => ({ path: f.path, sha256: f.sha256 })), lockInode: String(lstatSync(join(runDir, 'lock')).ino),
      });
      record.request = snapshot.request;
      record.input = { snapshotSha256: sha256File(join(runDir, 'inputs', 'snapshot.json')), requestSha256: snapshot.requestSha256, inventorySha256: snapshot.inventorySha256 };
      if (!lock) throw new HarnessError('lock_prerequisite_missing');
      const boundary = await verifyDockerBoundary(docker, env);
      record.docker = { endpoint: options.endpoint, engineId: boundary.engineId, observed: boundary.observed };
      if (!boundary.ok) throw new HarnessError('docker_boundary_refused', boundary.failures);
      // Nothing has been created yet. From here every resource lands in the ledger this binding names.
      bindCleanup(journal, runDir, { runId: options['run-id'], endpoint: options.endpoint, engineId: boundary.engineId });
      resources.engineId = boundary.engineId;
      const repoRoot = gitOut(['rev-parse', '--show-toplevel'], HARNESS_DIR).trim();
      const identities = resolveIdentities({ repoRoot, subjectRef: options['candidate-ref'] });
      if (identities.subjectCommit !== options['candidate-ref']) throw new HarnessError('candidate_ref_not_full_commit');
      record.candidate = { commit: identities.subjectCommit };
      record.harness = { commit: identities.harnessCommit, tree: identities.harnessTree };
      const built = await build(docker, resources, { repoRoot, outDir: runDir, identities, exercise: true });
      resources.record({ event: 'image_retained', kind: 'image', id: built.runtime.imageId });
      record.artifact = { file: built.artifact.file, sha256: built.artifact.sha256, report: built.artifact.report, core: built.artifact.core };
      record.runtime = { imageId: built.runtime.imageId, identity: runtimeIdentity(built.runtime), pluginTarballSha256: built.runtime.pluginTarballSha256, exerciseCore: built.runtime.exerciseCore };
      const runtimeProblems = [...runtimeFailures(built.runtime), ...exerciseCoreFailures(built.artifact, built.runtime, identities.subjectCommit)];
      if (built.runtime.pluginTarballSha256 !== built.artifact.sha256) runtimeProblems.push('installed_artifact_mismatch');
      if (runtimeProblems.length) throw new HarnessError('runtime_checks_failed', runtimeProblems);
      record.isolation = ISOLATION;
      record.qualification = await qualify({ runDir, journal, docker, resources, env, host: options.host, imageId: built.runtime.imageId, runId: options['run-id'], engineId: boundary.engineId, endpoint: options.endpoint }, budget);
      if (record.qualification.failures.length) throw new HarnessError('qualification_failed', record.qualification.failures);
      record.status = 'prepared';
    } catch (error) {
      record.failures.push({ code: error instanceof HarnessError || error instanceof CredentialError ? error.code : 'unexpected_exception', detail: error instanceof HarnessError ? error.detail ?? null : null });
    }
    record.cleanup = await resources.removeAll();
    record.resources = { ...resources.counts, settled: resources.settled };
    if (!resources.settled) {
      record.status = 'failed';
      record.failures.push({ code: 'cleanup_unsettled' });
    }
    const written = journal.write('prepared', record);
    return {
      exit: record.status === 'prepared' ? EXIT.ok : EXIT.failed,
      status: controllerStatus('prepare', { status: record.status, preparedSha256: written.sha256, failures: record.failures.map((f) => f.code), qualification: record.qualification?.summary ?? null, retainedImages: resources.counts.retainedImages }),
    };
  } finally {
    lock?.release();
  }
}

/** The catalog reply checked against every explicit choice and needed agent; each problem is a fixed word. */
export function catalogProblems(reply, { choices, labels, agents }) {
  if (reply.choices.length !== choices.length) return ['catalog_mismatch'];
  const out = [];
  reply.choices.forEach((found, i) => {
    if (found.ref !== choices[i].ref) { out.push('catalog_mismatch'); return; }
    if (!found.listed || !found.toolCall) out.push(labels[i].model);
    if (choices[i].variant && found.variantListed !== true) out.push(labels[i].variant);
  });
  for (const role of agents) if (reply.agents[role] !== true) out.push(`agent:${role}`);
  return out;
}

/**
 * Starts the named live run. Credential-free setup and the shared-clock check first; then one bounded auth read, the
 * exact-token scan of the authorization and inputs, guard bind and arm, injection, catalog validation, session creation
 * and the initial prompt. Any failure after resources exist attempts cleanup.
 */
export async function startCommand(options, env, overrides = {}, deps = {}) {
  const setupBudget = commandBudget(COMMAND_MS.start, deps);
  const ctx = openRun(options.run, env, setupBudget, deps);
  const { journal, prepared } = ctx;
  if (ctx.state.stopped.length || journal.read('start.intent')) throw new ExerciseRefusal('already_started');
  if (journal.read('latch')) throw new ExerciseRefusal('run_latched');
  const auth = readJsonInput(options.authorization, 64 * 1024, 'authorization_invalid');
  const authorization = validateAuthorization(auth.value, { runId: prepared.runId, preparedSha256: ctx.preparedSha256, prepared, budgetSeconds: options.budgetSeconds });
  // Token shapes are refused, and the run latched, before anything else is recorded; the exact token is checked once it
  // has been read.
  if (inputContaminated(ctx.scan, auth)) {
    latch(journal, 'authorization_contaminated');
    throw new ExerciseRefusal('authorization_contaminated');
  }
  const snapshot = snapshotOf(options.run);
  const provider = overrides.provider ?? 'openai';
  const modelRef = overrides.modelRef ?? prepared.request.model.ref;
  const variant = overrides.modelRef ? null : prepared.request.model.variant;
  journal.write('start.intent', { at: new Date().toISOString(), budgetSeconds: options.budgetSeconds, provider: overrides.provider ? 'mock' : 'openai', authorizationSha256: auth.sha256 });
  const result = { command: 'start', status: 'failed', failures: [] };
  let postBudget = null;
  try {
    const boundary = await verifyDockerBoundary(ctx.docker, env);
    if (!boundary.ok || boundary.engineId !== prepared.docker.engineId) throw new HarnessError('docker_engine_changed');
    const image = await ctx.docker.json(['image', 'inspect', '--format', '{{json .Id}}', prepared.runtime.imageId], { timeoutMs: 30_000 });
    if (image !== prepared.runtime.imageId) throw new HarnessError('runtime_image_missing');
    const network = overrides.network ?? await ctx.resources.create('network', (labels) => ['network', 'create', '--driver', 'bridge', ...labels, `ic-ex-${prepared.runId}-${randomBytes(4).toString('hex')}`]);
    const ceilingSeconds = SETUP_SECONDS + options.budgetSeconds;
    await openContainer(ctx, { network, ceilingSeconds }, setupBudget);
    journal.write('start.container', { id: ctx.containerId, network, ceilingSeconds });
    const setup = await driver(ctx, 'setup', {
      provider, modelRef, variant, agentMode: prepared.request.agentMode, agentModels: prepared.request.agentModels,
      askExternalReads: overrides.askExternalReads === true, qualification: overrides.qualification === true,
      warmAgents: [...new Set([prepared.request.initialPrimary, ...prepared.request.primaryTransitions.map((t) => t.to)])],
      files: overrides.qualification ? [] : snapshot.files.map((f) => ({ path: f.path, content: f.content })), skills: snapshot.skills, dependencies: prepared.request.dependencies,
    }, setupBudget);
    if (!setup.value?.ok) throw new HarnessError(setup.value?.failure ?? 'setup_failed');
    // Every cutoff a driver receives is on the container clock the guard keeps its deadline on; a driver reading that
    // falls between two guard readings shows both read one clock. Nothing live happens without that evidence.
    const before = await guardCall(ctx, ['status'], setupBudget);
    const reading = await driver(ctx, 'clock', {}, setupBudget);
    const after = await guardCall(ctx, ['status'], setupBudget);
    if (!sharedClockBracket(before?.clockMs, reading.value?.clockMs, after?.clockMs)) throw new HarnessError('clock_domain_unproven');

    // ---- Credential boundary. One bounded read; its fingerprint is bound in the guard before arming.
    let snapshotAuth;
    try { snapshotAuth = snapshotAuthFile(ctx.authPath); } catch (error) { throw new HarnessError(error instanceof CredentialError ? error.code : 'auth_unreadable'); }
    const status = await guardCall(ctx, ['status'], setupBudget);
    const liveMs = options.budgetSeconds * 1000;
    if (!status?.ok || status.armed || !(status.ceilingRemainingMs >= liveMs)) throw new HarnessError('ceiling_insufficient');
    let credential;
    try {
      ({ credential } = credentialFromSnapshot(snapshotAuth, { now: Date.now(), requiredMs: operationLifetimeMs(ctx.host, liveMs) }));
    } catch (error) {
      throw new HarnessError(error instanceof CredentialError ? error.code : 'auth_malformed');
    }
    // The authorization and every snapshotted input are checked against the exact token before anything is recorded,
    // bound or injected; from here on every status this command prints is scanned for it too.
    const exact = evidenceScanner(credential);
    ctx.scan = exact;
    if (inputContaminated(exact, auth)) throw new HarnessError('authorization_contaminated');
    if (scanValue(exact, snapshot)) throw new HarnessError('input_contaminated');
    journal.write('authorization', { ...authorization, sourceSha256: auth.sha256 });
    const bound = await guardCall(ctx, ['bind'], setupBudget, { input: JSON.stringify({ runId: prepared.runId, host: ctx.host, fingerprint: fingerprintWire(snapshotAuth.fingerprint) }) });
    snapshotAuth = null;
    if (!bound?.ok || bound.boundRunId !== prepared.runId) throw new HarnessError('guard_bind_failed');
    const armed = await guardCall(ctx, ['arm', String(options.budgetSeconds)], setupBudget);
    if (!armed?.ok || !armed.armed || !(armed.remainingMs > 0 && armed.remainingMs <= liveMs)) throw new HarnessError('guard_arm_failed');
    journal.write('start.armed', { deadlineAt: armed.deadlineAt, ceilingAt: armed.ceilingAt, armedAt: armed.armedAt, budgetSeconds: options.budgetSeconds });
    // After arming, start has a short window bounded by the live deadline as well.
    const windowMs = Math.min(COMMAND_MS.postArm, Math.max(0, armed.remainingMs - NO_NEW_WORK_MS));
    postBudget = deadline(windowMs);
    const post = deadline(Math.max(0, windowMs - GATE_RESERVE_MS));
    ctx.resources.remainingMs = post.left;
    ctx.trusted = true;
    ctx.expected = credential;
    journal.write('start.inject', { at: new Date().toISOString() });
    const injected = await driver(ctx, 'inject', { request: authRequest(ctx.host, credential) }, post, { reserveMs: NO_NEW_WORK_MS });
    if (!injected.value?.ok) throw new HarnessError('auth_injection_failed');
    // Every explicit choice is validated against the actual catalogs: the session's model and variant, then each role override.
    const overrideRoles = Object.keys(prepared.request.agentModels);
    const choices = [{ ref: modelRef, variant }, ...overrideRoles.map((role) => ({ ref: prepared.request.agentModels[role].model, variant: prepared.request.agentModels[role].variant }))];
    const labels = [{ model: 'model', variant: 'variant' }, ...overrideRoles.map((role) => ({ model: `agent_model:${role}`, variant: `agent_variant:${role}` }))];
    const roles = [...new Set([prepared.request.initialPrimary, ...prepared.request.primaryTransitions.map((t) => t.to), ...overrideRoles])];
    const catalog = await driver(ctx, 'catalog', { choices, agents: roles }, post);
    if (!catalog.value?.ok) throw new HarnessError(catalog.value?.failure ?? 'catalog_unreadable');
    const missing = catalogProblems(catalog.value, { choices, labels, agents: roles });
    if (missing.length) throw new HarnessError('selection_unavailable', missing);
    const created = await driver(ctx, 'create-session', { agent: prepared.request.initialPrimary, model: { ref: modelRef, variant } }, post, { reserveMs: NO_NEW_WORK_MS });
    if (!created.value?.ok) throw new HarnessError(created.value?.failure ?? 'session_create_unknown');
    journal.write('start.session', { sessionId: created.value.sessionId, agent: prepared.request.initialPrimary, model: { ref: modelRef, variant }, containerId: ctx.containerId, provider: overrides.provider ? 'mock' : 'openai' });
    ctx.state = runState(journal);
    let text = snapshot.brief ? `${snapshot.prompt}\n\n${snapshot.brief}` : snapshot.prompt;
    if (overrides.qualification) {
      const scripted = await driver(ctx, 'qualification-prompt', { step: 'planning' }, post);
      if (!scripted.value?.ok) throw new HarnessError('qualification_prompt_failed');
      text = scripted.value.text;
    }
    const op = await submitOperation(ctx, { id: 'initial-prompt', action: 'prompt', text }, post, { credential, guardRemainingMs: armed.remainingMs }, overrides.faults ?? {});
    result.status = op.state === 'acknowledged' ? 'started' : op.state === 'unknown' ? 'started_unknown_initial_prompt' : 'started_initial_prompt_refused';
    result.sessionId = created.value.sessionId;
    result.deadlineAt = armed.deadlineAt;
    result.operation = op;
  } catch (error) {
    result.failures.push(error instanceof HarnessError ? error.code : 'unexpected_exception');
    if (error instanceof HarnessError && Array.isArray(error.detail)) result.detail = error.detail.filter((d) => typeof d === 'string' && /^[A-Za-z0-9_:.-]{1,80}$/.test(d));
    const stop = deadline(COMMAND_MS.stop);
    ctx.resources.remainingMs = stop.left;
    const cleanup = await cleanupResources(ctx);
    result.cleanup = cleanup.state;
    journal.write(ctx.state.next('stop'), { at: new Date().toISOString(), reason: 'start_failed', ...cleanup });
  }
  if (!result.failures.length && ctx.trusted) {
    // The session exists and is credential-bearing: its status leaves only through the release gate.
    const published = await publishStatus(ctx, postBudget, result, { command: 'start', sessionId: result.sessionId, deadlineAt: result.deadlineAt });
    journal.write('start.result', published.status);
    return { exit: !published.published ? EXIT.failed : result.status === 'started' ? EXIT.ok : EXIT.busy, status: published.status };
  }
  const status = scannedStatus(ctx.scan, result, { command: 'start', status: result.status, failures: result.failures, ...(result.cleanup ? { cleanup: result.cleanup } : {}) });
  journal.write('start.result', status);
  return { exit: result.failures.length ? EXIT.failed : result.status === 'started' ? EXIT.ok : EXIT.busy, status };
}

/**
 * Submits one operation: intent first (with every exact native identity known before the effect, scanned before it is
 * recorded), a fresh credential and guard check immediately before the driver call, the driver's own precondition
 * check and its single submission inside both cutoffs, then the credential postcheck before anything is published. A
 * lost acknowledgement leaves the operation unknown; a driver that never ran leaves it refused, because nothing was sent.
 */
async function submitOperation(ctx, op, budget, auth, faults = {}) {
  const { journal } = ctx;
  const state = runState(journal);
  if (state.unresolved.length) return { state: 'blocked', reason: 'operation_unresolved', unresolved: state.unresolved };
  if (state.ops.some((o) => o.intent.id === op.id)) throw new HarnessError('operation_id_reused');
  // An early look with the time the caller last measured. The decisive admission is made again, with fresh guard time,
  // immediately before the effect.
  if (!admitsAction(op.action, auth.guardRemainingMs)) return { state: 'refused', reason: 'no_new_work_window' };
  const session = state.session;
  const model = session.model;
  const seq = state.next('op').slice(3);
  const intent = { id: op.id, action: op.action, sessionId: session.sessionId, at: new Date().toISOString() };
  let driverOp;
  let pre = null;
  if (op.action === 'reply' || op.action === 'permission') {
    // The exact pending request, its owner session and tool call, recorded before anything is sent.
    pre = await driver(ctx, 'observe', { sessionId: session.sessionId }, budget);
    if (!pre.value?.ok) return failClosed(ctx, pre, 'observe_failed');
    const target = (pre.value.pending ?? []).find((p) => p.id === op.requestId && p.kind === (op.action === 'reply' ? 'question' : 'permission') && !p.outsideTree);
    if (!target) return { state: 'refused', reason: 'request_not_pending', pending: pre.value.pending };
    Object.assign(intent, {
      kind: op.action === 'reply' ? 'question-reply' : 'permission-reply', requestId: target.id, ownerSessionId: target.sessionId, toolCallId: target.toolCallId,
      ...(op.decision ? { decision: op.decision } : {}), ...(op.action === 'reply' ? { answers: op.answers } : {}),
    });
    driverOp = { kind: intent.kind, requestId: op.requestId, answers: op.answers, decision: op.decision };
  } else if (op.action === 'prompt' || op.action === 'approve-plan') {
    const messageId = exerciseMessageId(Date.now(), Number(seq));
    let text = op.text;
    let plan = null;
    if (op.action === 'approve-plan') {
      plan = { feature: op.feature, revision: op.revision, contentHash: op.contentHash };
      text = approvalMessage(op) + (faults.approvalScript ? `\n${faults.approvalScript(op)}` : '');
    }
    Object.assign(intent, { kind: 'prompt', messageId, agent: state.primary, ...(plan ? { plan } : {}) });
    driverOp = { kind: 'prompt', sessionId: session.sessionId, messageId, agent: state.primary, model, text, plan };
  } else if (op.action === 'switch-primary') {
    const allowed = ctx.prepared.request.primaryTransitions.some((t) => t.from === state.primary && t.to === op.to);
    if (!allowed) return { state: 'refused', reason: 'transition_not_allowed' };
    if (!state.lastApproval) return { state: 'refused', reason: 'approval_not_observed' };
    Object.assign(intent, { kind: 'switch', agent: op.to, from: state.primary, approval: state.lastApproval });
    driverOp = { kind: 'switch', sessionId: session.sessionId, agent: op.to, from: state.primary, requireApproval: state.lastApproval };
  } else if (op.action === 'interrupt') {
    Object.assign(intent, { kind: 'interrupt' });
    driverOp = { kind: 'interrupt', sessionId: session.sessionId };
  } else throw new HarnessError('operation_invalid');
  // The record is a published artifact: what the supervisor wrote was scanned on import and the native identities
  // arrived through scanned replies, and the whole intent is scanned again before it is written.
  if (scanValue(ctx.scan, intent)) {
    latch(journal, 'operation_contaminated');
    return { state: 'refused', reason: 'operation_contaminated', latched: true };
  }
  journal.write(`op.${seq}.intent`, intent);
  const refuseRecorded = (reason, extra = {}) => {
    journal.write(`op.${seq}.outcome`, { state: 'refused', reason });
    return { id: op.id, seq, state: 'refused', reason, ...extra };
  };
  const before = ctx.trusted ? await continuity(ctx, budget) : { ok: true, guardRemainingMs: (await guardCall(ctx, ['status'], budget))?.remainingMs };
  if (!before.ok) {
    latch(journal, before.code);
    journal.write(`op.${seq}.outcome`, { state: 'refused', reason: before.code });
    return { state: 'refused', reason: before.code, latched: true };
  }
  if (!admitsAction(op.action, before.guardRemainingMs)) return refuseRecorded('no_new_work_window');
  const sent = await driver(ctx, 'submit', { sessionId: session.sessionId, op: driverOp, dropAcknowledgement: faults.dropAcknowledgement === true }, budget, { reserveMs: actionReserveMs(op.action) });
  if (sent.notSent) return refuseRecorded(sent.notSent);
  const checked = ctx.trusted ? await continuity(ctx, budget, { requireLifetime: false }) : { ok: true };
  if (!checked.ok) {
    // The request may have been accepted before the postcheck failed: it stays possibly executed, never replayed.
    latch(journal, checked.code);
    if (sent.value?.submitted !== false) journal.write(`op.${seq}.outcome`, { state: 'unknown', reason: checked.code });
    else journal.write(`op.${seq}.outcome`, { state: 'refused', reason: checked.code });
    return { state: sent.value?.submitted === false ? 'refused' : 'unknown', reason: checked.code, latched: true };
  }
  if (sent.contaminated || ['evidence_contaminated', 'native_auth_changed', 'scanner_unavailable'].includes(sent.value?.failure)) {
    latch(journal, sent.contaminated ? 'evidence_contaminated' : sent.value.failure);
    journal.write(`op.${seq}.outcome`, { state: 'unknown', reason: 'content_unavailable' });
    return { state: 'unknown', reason: 'content_unavailable', latched: true };
  }
  const v = sent.value;
  let outcome;
  if (sent.timedOut) outcome = { state: 'unknown', reason: 'driver_timeout' };
  else if (!v) outcome = { state: 'unknown', reason: sent.invalid ? 'driver_reply_invalid' : 'driver_reply_missing' };
  else if (v.ok === false && v.failure === 'deadline_exceeded' && v.submitted === false) outcome = { state: 'refused', reason: 'deadline_exceeded' };
  else if (v.ok === false) outcome = { state: 'unknown', reason: failureWord(v.failure) };
  else if (v.submitted === false && v.local === true) outcome = { state: 'acknowledged', local: true };
  else if (v.submitted === false) outcome = { state: 'refused', reason: failureWord(v.refused), reasons: v.reasons ?? [], ...(v.currentRevision ? { currentRevision: v.currentRevision } : {}) };
  else if (v.acknowledged === true) outcome = { state: 'acknowledged', status: v.status ?? null };
  else if (v.acknowledged === false) outcome = { state: 'rejected', status: v.status ?? null };
  else outcome = { state: 'unknown', reason: 'acknowledgement_lost' };
  // The record is a published artifact too: nothing native reaches it unscanned.
  if (scanValue(evidenceScanner(checked.credential ?? null), outcome)) {
    latch(journal, 'evidence_contaminated');
    journal.write(`op.${seq}.outcome`, { state: 'unknown', reason: 'content_unavailable' });
    return { state: 'unknown', reason: 'content_unavailable', latched: true };
  }
  journal.write(`op.${seq}.outcome`, outcome);
  return { id: op.id, seq, ...outcome, ...(outcome.state === 'refused' && v?.pending ? { pending: v.pending } : {}) };
}

function failClosed(ctx, reply, code) {
  if (reply.contaminated || ['evidence_contaminated', 'native_auth_changed', 'scanner_unavailable'].includes(reply.value?.failure)) {
    latch(ctx.journal, reply.contaminated ? 'evidence_contaminated' : reply.value.failure);
    return { state: 'refused', reason: 'content_unavailable', latched: true };
  }
  return { state: 'refused', reason: reply.timedOut ? 'driver_timeout' : reply.invalid ? 'driver_reply_invalid' : failureWord(reply.value?.failure ?? code) };
}

/**
 * A fixed word for a failure, refusal or reason: a member of the driver's enumerated sets or the controller's own
 * words, otherwise 'other'. A string that merely looks harmless is not a safe diagnostic.
 */
export function failureWord(value) {
  return typeof value === 'string' && (DRIVER_FAILURES.has(value) || DRIVER_REFUSALS.has(value) || CONTROLLER_WORDS.has(value)) ? value : 'other';
}

const CONTROLLER_WORDS = new Set(['observe_failed', 'driver_timeout', 'driver_reply_invalid', 'driver_reply_missing', 'content_unavailable', 'acknowledgement_lost', 'no_new_work_window', 'clock_unavailable', 'operation_contaminated']);

/** The native user message that carries a revision-bound approval decision. The controller itself approves nothing. */
export function approvalMessage(op) {
  return [
    `Supervisor decision: approve the plan of feature '${op.feature}' in the project at ${op.project}, revision ${op.revision} (content hash ${op.contentHash}), and only that revision.`,
    `Call hive_plan_approve with feature '${op.feature}', expectedRevision '${op.revision}' and sync true, then report the separate approval and sync outcomes.`,
    'If the current plan revision differs from the one named here, do not approve; read the plan again and report the difference instead.',
    `Permitted local work after approval: ${op.permittedWork}`,
  ].join('\n');
}

/** Guard status and credential continuity for a content command; failures latch the run. */
async function liveContext(ctx, budget) {
  if (!ctx.state.session) throw new ExerciseRefusal('run_not_started');
  if (ctx.state.latch) throw new ExerciseRefusal('run_latched', ctx.state.latch.code);
  if (ctx.state.stopped.length) throw new ExerciseRefusal('run_stopped');
  if (!ctx.trusted) throw new ExerciseRefusal('run_not_credentialed');
  const auth = await continuity(ctx, budget);
  if (!auth.ok) {
    latch(ctx.journal, auth.code);
    throw new ExerciseRefusal('run_latched', auth.code);
  }
  ctx.expected = auth.credential;
  ctx.scan = evidenceScanner(auth.credential);
  return auth;
}

/** A command's working budget: its share of the command time left after the release gate's reserve. */
function workBudget(budget) {
  return deadline(Math.max(0, budget.left() - GATE_RESERVE_MS));
}

export async function turnCommand(options, env, faults = {}, deps = {}) {
  const budget = commandBudget(COMMAND_MS.turn, deps);
  const work = workBudget(budget);
  const ctx = openRun(options.run, env, work, deps);
  const file = readJsonInput(options.operation, 128 * 1024, 'operation_invalid');
  const op = validateOperation(file.value, {
    runId: ctx.prepared.runId, sessionId: ctx.state.session?.sessionId, allowedActions: ctx.state.authorization?.allowedActions ?? [],
  });
  // Statuses that do not pass the release gate are still scanned whole; a hit leaves fixed words only.
  const reply = (exit, status) => ({ exit, status: scannedStatus(ctx.scan, status, { command: 'turn', status: 'content_unavailable', reason: 'status_contaminated' }) });
  if (ctx.state.unresolved.length) return reply(EXIT.busy, { command: 'turn', status: 'blocked', reason: 'operation_unresolved', unresolved: ctx.state.unresolved });
  if (work.left() <= 0) return reply(EXIT.failed, { command: 'turn', status: 'refused', reason: 'command_deadline_exceeded' });
  let auth;
  try {
    auth = await liveContext(ctx, work);
  } catch (error) {
    if (error instanceof ExerciseRefusal) return reply(EXIT.failed, { command: 'turn', status: 'refused', reason: error.code, ...(error.detail ? { latch: error.detail } : {}) });
    throw error;
  }
  // The whole operation, as written and as decoded, is checked against the original token before any of it is
  // recorded, sent or echoed; the refusal names nothing from the file and latches the run, so no later input resumes it.
  if (inputContaminated(ctx.scan, file)) {
    latch(ctx.journal, 'operation_contaminated');
    return reply(EXIT.invalid, { command: 'turn', status: 'refused', reason: 'operation_contaminated', latched: true });
  }
  const result = await submitOperation(ctx, op, work, auth, faults);
  const exit = result.state === 'acknowledged' ? EXIT.ok : result.state === 'unknown' || result.state === 'blocked' ? EXIT.busy : EXIT.failed;
  const status = { command: 'turn', operation: op.id, ...result };
  if (result.latched) return reply(exit, status);
  const published = await publishStatus(ctx, budget, status, { command: 'turn', operation: op.id, state: result.state });
  return { exit: published.published ? exit : result.state === 'unknown' ? EXIT.busy : EXIT.failed, status: published.status };
}

export async function inspectCommand(options, env, deps = {}) {
  const budget = commandBudget(COMMAND_MS.inspect, deps);
  const work = workBudget(budget);
  const ctx = openRun(options.run, env, work, deps);
  const snapshot = snapshotOf(options.run);
  const file = options.request ? readJsonInput(options.request, 64 * 1024, 'inspection_invalid') : null;
  const request = file ? validateInspection(file.value, { runId: ctx.prepared.runId, artifacts: snapshot.request.artifacts }) : null;
  const base = { command: 'inspect', lifecycle: lifecycleFacts(ctx) };
  // Until the credential is checked there is no scanner for the original token: those statuses are closed controller
  // facts. After it, a status that does not pass the release gate is scanned whole with that scanner; a hit leaves fixed
  // words only.
  const controllerReply = (exit, status) => ({ exit, status: controllerStatus('inspect', status) });
  const reply = (exit, status) => ({ exit, status: scannedStatus(ctx.scan, status, { command: 'inspect', status: 'content_unavailable', reason: 'status_contaminated' }) });
  if (ctx.state.latch || !ctx.state.session || ctx.state.stopped.length) {
    return controllerReply(ctx.state.latch ? EXIT.failed : EXIT.ok, { ...base, status: ctx.state.latch ? 'content_unavailable' : ctx.state.stopped.length ? 'stopped' : 'not_started' });
  }
  if (work.left() <= 0) return controllerReply(EXIT.failed, { ...base, status: 'refused', reason: 'command_deadline_exceeded' });
  let auth;
  try {
    auth = await liveContext(ctx, work);
  } catch (error) {
    if (error instanceof ExerciseRefusal) return controllerReply(EXIT.failed, { ...base, status: 'content_unavailable', reason: error.detail ?? error.code });
    throw error;
  }
  if (file && inputContaminated(ctx.scan, file)) {
    latch(ctx.journal, 'inspection_contaminated');
    return reply(EXIT.invalid, { command: 'inspect', status: 'refused', reason: 'inspection_contaminated', latched: true });
  }
  const target = request?.resolve ? ctx.state.ops.find((o) => o.intent.id === request.resolve) : null;
  if (request?.resolve && (!target || target.state !== 'unknown')) return reply(EXIT.invalid, { ...base, status: 'refused', reason: 'operation_not_unknown' });
  const diffBase = request?.diff ? Object.fromEntries((request.artifacts ?? []).map((p) => [p, snapshot.files.find((f) => f.path === p)?.content ?? null])) : undefined;
  const observed = await driver(ctx, 'observe', {
    sessionId: ctx.state.session.sessionId,
    request: request ? { conversation: request.conversation, plan: request.plan, artifacts: request.artifacts, list: request.list, diff: request.diff } : {},
    base: diffBase,
    resolve: target ? {
      kind: target.intent.kind, sessionId: target.intent.sessionId, messageId: target.intent.messageId, requestId: target.intent.requestId, ownerSessionId: target.intent.ownerSessionId,
      toolCallId: target.intent.toolCallId, agent: target.intent.agent, from: target.intent.from, answers: target.intent.answers,
    } : undefined,
  }, work);
  if (observed.contaminated || !observed.value?.ok) {
    const failed = failClosed(ctx, observed, 'observe_failed');
    return reply(EXIT.failed, { ...base, status: failed.latched ? 'content_unavailable' : 'observe_failed', reason: failed.reason });
  }
  const seq = ctx.state.next('inspect');
  const evidenceFile = join(options.run, 'evidence', `${seq}.json`);
  const selection = observed.value.conversation ? selectionSummary(observed.value.conversation, { selected: ctx.state.session.model, agentModels: ctx.prepared.request.agentModels ?? {} }) : undefined;
  const evidence = { ...observed.value, ...(selection ? { selection } : {}), at: new Date().toISOString(), guardRemainingMs: auth.guardRemainingMs };
  const pending = observed.value.pending ?? null;
  const status = {
    status: 'observed', guardRemainingMs: auth.guardRemainingMs, quiescent: observed.value.quiescent, reasons: observed.value.reasons, pending, ...(target ? { resolution: observed.value.resolution } : {}),
    ...(selection ? { selectionMismatches: selection.filter((s) => s.status === 'mismatch').map((s) => s.sessionId), selectionUnknown: selection.filter((s) => s.status === 'unknown').map((s) => s.sessionId) } : {}),
    ...(observed.value.plan ? { plan: { ok: observed.value.plan.ok, ...(observed.value.plan.ok ? { revision: observed.value.plan.revision, contentHash: observed.value.plan.contentHash, status: observed.value.plan.status, featurePath: observed.value.plan.featurePath, pluginRead: observed.value.plan.pluginRead } : { failure: observed.value.plan.failure }) } } : {}),
  };
  // Nothing is written or published before the release gate: the final continuity check and the decoded scan of the
  // evidence document and the whole status line, with a scanner built from the original token.
  const gate = await releaseGate(ctx, budget, { evidence, status, base, evidenceFile });
  if (!gate.ok) return reply(EXIT.failed, { ...base, status: 'content_unavailable', reason: gate.code });
  if (target && observed.value.resolution?.resolved) ctx.journal.write(`op.${target.seq}.resolution`, { resolved: true, effect: observed.value.resolution.effect ?? 'accepted', by: seq });
  mkdirSync(join(options.run, 'evidence'), { recursive: true });
  writeOnce(evidenceFile, JSON.stringify(evidence, null, 2));
  ctx.journal.write(seq, { evidence: relative(options.run, evidenceFile), sha256: sha256File(evidenceFile), quiescent: observed.value.quiescent, resolved: target ? observed.value.resolution?.resolved === true : null });
  return { exit: EXIT.ok, status: { ...base, lifecycle: lifecycleFacts({ ...ctx, state: runState(ctx.journal) }), evidence: evidenceFile, ...status } };
}

/**
 * Observed model selection per exported session against the request. Each assistant turn is judged against what its
 * agent should run: a role with an explicit `agentModels` entry expects that model and variant, every other role the
 * run's selected model and variant. A different model, or a different variant, is a `mismatch`; a turn whose agent or
 * variant the host did not report, and a session with no assistant turn, is `unknown`. Recorded, never corrected.
 * v2 labels a turn that ran no variant `default` while v1 reports none; `default` therefore reads as "no variant" and
 * never confirms a requested one.
 */
export function selectionSummary(conversation, { selected, agentModels }) {
  return (conversation?.sessions ?? []).map((session) => {
    const seen = new Map();
    for (const t of session.turns) {
      if (t.role !== 'assistant' || !t.model?.modelID) continue;
      const model = `${t.model.providerID}/${t.model.modelID}`;
      const reported = t.model.variant ?? null;
      const variant = reported === 'default' ? null : reported;
      const expected = t.agent ? { model: agentModels[t.agent]?.model ?? selected.ref, variant: agentModels[t.agent] ? agentModels[t.agent].variant ?? null : selected.variant ?? null } : null;
      let status = 'unknown';
      if (expected) {
        if (model !== expected.model) status = 'mismatch';
        else if (expected.variant === null) status = variant === null ? 'match' : 'mismatch';
        else if (reported === null) status = 'unknown';
        else status = variant === expected.variant ? 'match' : 'mismatch';
      }
      seen.set(`${t.agent}|${model}|${reported}`, { agent: t.agent, model, variant: reported, expected, status });
    }
    const observed = [...seen.values()];
    const status = observed.some((o) => o.status === 'mismatch') ? 'mismatch' : observed.length === 0 || observed.some((o) => o.status === 'unknown') ? 'unknown' : 'match';
    return { sessionId: session.id, agent: session.agent, status, mismatch: status === 'mismatch', observed };
  });
}

/** Lifecycle facts safe in any state: fixed words, numbers, booleans and owned identities. */
function lifecycleFacts(ctx) {
  const s = ctx.state;
  return {
    host: ctx.host, trusted: s.trusted, latched: s.latch?.code ?? null, deadlineAt: s.armed?.deadlineAt ?? null, sessionId: s.session?.sessionId ?? null,
    primary: s.primary, operations: s.ops.map((o) => ({ id: o.intent.id, kind: o.intent.kind, state: o.state })), unresolved: s.unresolved,
    containerId: ctx.containerId, stopped: s.stopped.length > 0,
  };
}

/** Removes every owned resource by exact ID and classifies cleanup. Needs no credential and exports no content. */
async function cleanupResources(ctx) {
  const results = await ctx.resources.removeAll();
  const present = results.filter((r) => r.state === 'present');
  const unknown = results.filter((r) => r.state === 'unknown');
  const state = present.length ? 'cleanup_present' : unknown.length || !ctx.resources.settled ? 'cleanup_unknown' : 'cleanup_confirmed';
  return { state, retained: [...present, ...unknown], retainedImages: [ctx.imageId].filter(Boolean) };
}

/**
 * Creates the directory, ledger and lock of one qualification run inside a prepared run and records the parent's
 * ownership of it. The record is written before the qualification run can create any resource, so a later `stop` of
 * the prepared run always knows which ledgers to settle. It names the ledger and lock by inode, so a replaced file is
 * never mistaken for the owned one. Returns the qualification run's directory.
 */
export function registerSubrun(journal, runDir, name, { runId, engineId }) {
  if (!QUALIFICATION_SUBRUNS.includes(name)) throw new HarnessError('subrun_unknown');
  const sub = join(runDir, name);
  mkdirSync(sub);
  for (const d of ['docker-config', 'records', 'inputs']) mkdirSync(join(sub, d));
  writeOnce(join(sub, 'docker-config', 'config.json'), '{}\n');
  writeOnce(join(sub, 'resources.jsonl'), '');
  writeOnce(join(sub, 'lock'), '');
  journal.write(`subrun.${name}`, {
    schema: 'ic-exercise-subrun/v1', name, runId, engineId, ledgerIno: String(lstatSync(join(sub, 'resources.jsonl')).ino), lockIno: String(lstatSync(join(sub, 'lock')).ino),
  });
  return sub;
}

/**
 * Settles the resources of one qualification run the prepared run owns, by the ledger identity recorded at
 * registration. Anything that does not show an owned, settled ledger is unknown, never absent: an unregistered or
 * missing directory, a registration that does not fit, a replaced, linked or unreadable ledger or lock, a lock another
 * process holds, or a spent budget. Only the fixed names in QUALIFICATION_SUBRUNS are looked at, and a qualification
 * run owns nothing of its own, so there is no path to follow and no recursion.
 */
async function cleanupSubrun(name, { runDir, journal, owner, docker, budget, lockWaitSeconds }) {
  const unknown = { state: 'cleanup_unknown', retained: [{ subrun: name, state: 'unknown' }] };
  const dir = join(runDir, name);
  try {
    const record = journal.read(`subrun.${name}`);
    let exists = true;
    try { lstatSync(dir); } catch (error) { if (error?.code !== 'ENOENT') return unknown; exists = false; }
    if (record === null) return exists ? unknown : { state: 'cleanup_confirmed', retained: [] };
    const r = record.value;
    const registered = r && typeof r === 'object' && r.schema === 'ic-exercise-subrun/v1' && r.name === name && typeof r.runId === 'string' && r.runId !== ''
      && r.engineId === owner.engineId && /^\d+$/.test(r.ledgerIno) && /^\d+$/.test(r.lockIno);
    if (!exists || !registered || !lstatSync(dir).isDirectory()) return unknown;
    const owned = (file, ino) => { const stat = lstatSync(join(dir, file)); return stat.isFile() && stat.nlink === 1 && String(stat.ino) === ino; };
    if (!owned('resources.jsonl', r.ledgerIno) || !owned('lock', r.lockIno)) return unknown;
    const waitSeconds = Math.min(lockWaitSeconds, Math.floor(budget.left() / 1000));
    if (waitSeconds < 1) return unknown;
    const lock = await acquireRunLock(join(dir, 'lock'), { waitSeconds });
    if (lock.busy) return unknown;
    try {
      if (lock.ino !== r.lockIno) return unknown;
      const { resources } = runDocker(dir, owner.endpoint, owner.engineId, r.runId, budget, docker);
      const cleanup = await cleanupResources({ resources, imageId: null });
      return { state: cleanup.state, retained: cleanup.retained.map((item) => ({ ...item, subrun: name })) };
    } finally {
      lock.release();
    }
  } catch {
    return unknown;
  }
}

/**
 * Who owns what `stop` may remove: the engine, endpoint, run and ledger/lock identities, from prepare's cleanup binding
 * when it wrote one, which exists as soon as prepare could create a resource even if it never finished. A run with no
 * binding (a qualification run, or one prepared before bindings) is owned through its prepared record. Neither is
 * authority to start anything: `start` reads only a prepared record. Malformed, inconsistent or missing ownership is
 * refused; no engine or resource ID is ever guessed.
 */
export function cleanupOwner(journal, prepared) {
  let binding;
  try { binding = journal.read(CLEANUP_BINDING)?.value; } catch { throw new HarnessError('cleanup_binding_invalid'); }
  if (binding === undefined) {
    if (!prepared?.docker?.engineId) throw new HarnessError('run_not_prepared');
    return {
      endpoint: prepared.docker.endpoint, engineId: prepared.docker.engineId, runId: prepared.runId, ledgerIno: null,
      lockInode: journal.read('input')?.value?.lockInode, qualificationRun: prepared.qualificationRun === true,
    };
  }
  const sound = binding && typeof binding === 'object' && binding.schema === 'ic-exercise-cleanup-binding/v1' && typeof binding.runId === 'string' && binding.runId !== ''
    && typeof binding.endpoint === 'string' && /^unix:\/\/\/[^\s]+$/.test(binding.endpoint) && typeof binding.engineId === 'string' && binding.engineId !== ''
    && typeof binding.ledgerIno === 'string' && /^\d+$/.test(binding.ledgerIno) && typeof binding.lockInode === 'string' && /^\d+$/.test(binding.lockInode);
  if (!sound) throw new HarnessError('cleanup_binding_invalid');
  if (prepared && (prepared.docker?.engineId !== binding.engineId || prepared.docker?.endpoint !== binding.endpoint || prepared.runId !== binding.runId)) throw new HarnessError('cleanup_binding_mismatch');
  return { endpoint: binding.endpoint, engineId: binding.engineId, runId: binding.runId, ledgerIno: binding.ledgerIno, lockInode: binding.lockInode, qualificationRun: false };
}

/** The ledger is the file the binding named, with one name; a replaced, linked or missing ledger is not this run's. */
function requireBoundLedger(runDir, owner) {
  if (owner.ledgerIno === null) return;
  let stat;
  try { stat = lstatSync(join(runDir, 'resources.jsonl')); } catch { throw new HarnessError('cleanup_ledger_replaced'); }
  if (!stat.isFile() || stat.nlink !== 1 || String(stat.ino) !== owner.ledgerIno) throw new HarnessError('cleanup_ledger_replaced');
}

/** The image a build retained, from the ledger, for a run that never wrote a prepared record. */
function retainedImageOf(runDir) {
  let image = null;
  for (const line of readFileSync(join(runDir, 'resources.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    let entry;
    try { entry = JSON.parse(line); } catch { return null; }
    if (entry?.event === 'image_retained' && typeof entry.id === 'string') image = entry.id;
  }
  return image;
}

export async function stopCommand(options, env, deps = {}) {
  const budget = commandBudget(COMMAND_MS.stop, deps);
  const journal = new Journal(join(options.run, 'records'));
  const prepared = journal.read('prepared')?.value;
  const owner = cleanupOwner(journal, prepared);
  requireRecordedLock(options.run, { lockInode: owner.lockInode }, deps.lock);
  requireBoundLedger(options.run, owner);
  const { docker, resources } = runDocker(options.run, owner.endpoint, owner.engineId, owner.runId, budget, deps.docker);
  const own = await cleanupResources({ docker, resources, imageId: prepared?.runtime?.imageId ?? retainedImageOf(options.run) });
  // A qualification run owns no run of its own. The prepared run settles each qualification run it registered, so
  // cleanup_confirmed means every ledger it owns is settled, not only its own.
  const subs = [];
  if (!owner.qualificationRun) {
    for (const name of QUALIFICATION_SUBRUNS) {
      subs.push(await cleanupSubrun(name, { runDir: options.run, journal, owner, docker, budget, lockWaitSeconds: deps.subrunLockWaitSeconds ?? SUBRUN_LOCK_WAIT_SECONDS }));
    }
  }
  const parts = [own, ...subs];
  const cleanup = {
    state: parts.some((p) => p.state === 'cleanup_present') ? 'cleanup_present' : parts.some((p) => p.state === 'cleanup_unknown') ? 'cleanup_unknown' : 'cleanup_confirmed',
    retained: parts.flatMap((p) => p.retained), retainedImages: own.retainedImages,
  };
  const state = runState(journal);
  journal.write(state.next('stop'), { at: new Date().toISOString(), reason: 'requested', ...cleanup });
  return { exit: cleanup.state === 'cleanup_confirmed' ? EXIT.ok : EXIT.failed, status: controllerStatus('stop', { status: cleanup.state, retained: cleanup.retained, retainedImages: cleanup.retainedImages }) };
}

// -----------------------------------------------------------------------------------------------------------------
// Lock. flock(2) locks belong to an open file description and last until every descriptor of it is closed. This
// process opens the run's lock file itself; a finite util-linux `flock` child receives a duplicate of that descriptor as
// its fd 3, takes the lock on the shared description and exits. The lock then stays held through this process's own
// descriptor, which it closes only when the command has finished, and the kernel closes it if this process dies. Node
// opens every file close-on-exec, so Docker clients and other children never inherit it: the lock lasts exactly as
// long as the acting process, and a successor can take it only after that process has ended.

function flockAvailable() {
  const result = spawnSync('flock', ['--version'], { encoding: 'utf8' });
  return result.status === 0 && /util-linux/.test(result.stdout);
}

/**
 * Takes the lock on the open descriptor `fd` through one finite `flock` child, waiting up to `waitSeconds`. Resolves
 * 'held', 'busy' or 'failed' only after the child has exited, so no helper can still take the lock afterwards.
 */
function lockThroughHelper(fd, waitSeconds) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (outcome) => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise(outcome); } };
    const helper = spawn('flock', ['--exclusive', '--conflict-exit-code', String(LOCK_BUSY), '--wait', String(waitSeconds), '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
    // A helper that outlives its own wait is killed; its exit, not the kill, settles the outcome.
    const timer = setTimeout(() => helper.kill('SIGKILL'), (waitSeconds + 5) * 1000);
    helper.on('error', () => { if (helper.pid === undefined) settle('failed'); });
    helper.on('exit', (code, signal) => settle(code === 0 && signal === null ? 'held' : code === LOCK_BUSY ? 'busy' : 'failed'));
  });
}

/**
 * Acquires the run lock for this process. Opens the existing lock file without following a link, requires a regular
 * file with one name whose inode is still the one at the path, and locks it through `lockThroughHelper`. Resolves
 * `{ busy: true }` when another process holds it, or `{ busy: false, ino, release }`, where `release` closes this
 * process's descriptor and so ends the lock. On any other outcome the descriptor is closed before it throws.
 */
export async function acquireRunLock(lockPath, { waitSeconds = LOCK_WAIT_SECONDS } = {}) {
  let fd;
  try { fd = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw new HarnessError('lock_open_failed'); }
  let held = false;
  try {
    const opened = fstatSync(fd);
    const same = (stat) => stat.dev === opened.dev && stat.ino === opened.ino;
    if (!opened.isFile() || opened.nlink !== 1 || !same(lstatSync(lockPath))) throw new HarnessError('lock_file_replaced');
    const outcome = await lockThroughHelper(fd, waitSeconds);
    if (outcome === 'busy') return { busy: true };
    if (outcome !== 'held') throw new HarnessError('lock_acquire_failed');
    if (!same(lstatSync(lockPath))) throw new HarnessError('lock_file_replaced');
    held = true;
    let open = true;
    return { busy: false, ino: String(opened.ino), release: () => { if (open) { open = false; closeSync(fd); } } };
  } finally {
    if (!held) closeSync(fd);
  }
}

// -----------------------------------------------------------------------------------------------------------------
// Credential-free qualification

/** The qualification checks that every prepared run must pass, by name, so a missing observation fails. */
export const QUALIFICATION_CHECKS = [
  'lifetime.canary', 'lifetime.agentBindRefused', 'lifetime.bind', 'lifetime.secondBindRefused', 'lifetime.compareMatch', 'lifetime.compareMismatch',
  'lifetime.statusWithoutFingerprint', 'lifetime.armAcknowledged', 'lifetime.secondArmRefused', 'lifetime.stoppedWithoutHost',
  'protocol.started', 'protocol.questionPending', 'protocol.promptRefusedWhileQuestionPending', 'protocol.questionReplied',
  'protocol.permissionPendingInChild', 'protocol.promptRefusedWhileDescendantActive', 'protocol.permissionOnce', 'protocol.permissionReject',
  'protocol.childReturned', 'protocol.sameSessionMultiTurn', 'protocol.planParity', 'protocol.stalePlanRefused', 'protocol.commentParity',
  'protocol.approvalAckLost', 'protocol.noReplayWhileUnknown', 'protocol.resolvedByExactId', 'protocol.revisionBoundApproval', 'protocol.approvedParity',
  'protocol.switchRequiresApproval', 'protocol.switchAckLostSafe', 'protocol.primarySwitched', 'protocol.completed', 'protocol.lateDriverSendsNothing',
  'protocol.actionCutoffSendsNothing', 'protocol.directPlanRead', 'protocol.directApproval', 'clock.sharedDomain', 'clock.processClockRefused',
  'protocol.replyAckLost', 'protocol.replyNoReplay', 'protocol.replyResolvedByAnswers', 'protocol.permissionAckLost', 'protocol.permissionStaysUnknown',
  'protocol.lockBusy', 'protocol.lockSurvivesNoDescendant', 'protocol.rotationLatched', 'protocol.latchedInspectWithoutContent', 'protocol.cleanupWithoutAuth',
  'interrupt.started', 'interrupt.ackLost', 'interrupt.noReplay', 'interrupt.staysUnknown', 'interrupt.cleanupWithoutAuth',
];

export function qualificationFailures(checks) {
  return QUALIFICATION_CHECKS.filter((name) => checks[name] !== true);
}

async function qualify(base, budget) {
  const checks = {};
  const notes = {};
  // Each step records into `checks` as it observes, so a later failure keeps every earlier observation.
  try {
    await qualifyLifetime(base, budget, checks);
  } catch (error) {
    notes.lifetime = error instanceof HarnessError ? error.code : 'unexpected_exception';
  }
  try {
    await qualifyProtocol(base, budget, notes, checks);
  } catch (error) {
    notes.protocol = error instanceof HarnessError ? error.code : 'unexpected_exception';
  }
  try {
    await qualifyInterruptLoss(base, budget, notes, checks);
  } catch (error) {
    notes.interrupt = error instanceof HarnessError ? error.code : 'unexpected_exception';
  }
  const failures = qualificationFailures(checks);
  return { mockModel: QUALIFICATION_MOCK_MODEL, checks, notes, failures, summary: { passed: QUALIFICATION_CHECKS.length - failures.length, total: QUALIFICATION_CHECKS.length, failures } };
}

/** Guard abandonment on a short synthetic deadline: bind once, compare, arm once, then no host action until it stops. */
async function qualifyLifetime(base, budget, c) {
  const ctx = { ...base, scan: () => false, containerId: null };
  const id = await openContainer(ctx, { network: 'none', ceilingSeconds: 120 }, budget);
  try {
    const canary = lastJsonLine((await base.docker.run(['exec', '--user', AGENT_USER, id, 'node', FIXTURE, 'canary', '{}'], { timeoutMs: 60_000 })).stdout);
    c['lifetime.canary'] = canary?.heartbeat === true && canary?.guardSignal === 'EPERM';
    const fp = { exists: true, size: '10', mtimeNs: '1700000000000000001', ino: '42', digest: 'a'.repeat(64) };
    const agentBind = await guardCall(ctx, ['bind'], budget, { user: AGENT_USER, input: JSON.stringify({ runId: 'q', host: base.host, fingerprint: fp }) });
    c['lifetime.agentBindRefused'] = agentBind?.ok !== true;
    const bound = await guardCall(ctx, ['bind'], budget, { input: JSON.stringify({ runId: 'q', host: base.host, fingerprint: fp }) });
    c['lifetime.bind'] = bound?.ok === true && bound.bound === true;
    const again = await guardCall(ctx, ['bind'], budget, { input: JSON.stringify({ runId: 'q2', host: base.host, fingerprint: { ...fp, size: '11' } }) });
    c['lifetime.secondBindRefused'] = again?.ok === false && again.failure === 'already_bound';
    const match = await guardCall(ctx, ['compare'], budget, { input: JSON.stringify({ fingerprint: fp }) });
    const mismatch = await guardCall(ctx, ['compare'], budget, { input: JSON.stringify({ fingerprint: { ...fp, mtimeNs: '1700000000000000002' } }) });
    c['lifetime.compareMatch'] = match?.ok === true && match.matches === true;
    c['lifetime.compareMismatch'] = mismatch?.ok === true && mismatch.matches === false;
    const status = await guardCall(ctx, ['status'], budget);
    c['lifetime.statusWithoutFingerprint'] = status?.ok === true && !JSON.stringify(status).includes(fp.digest) && !JSON.stringify(status).includes(fp.mtimeNs);
    const armed = await guardCall(ctx, ['arm', '15'], budget);
    c['lifetime.armAcknowledged'] = armed?.ok === true && armed.armed === true && armed.remainingMs > 0 && armed.remainingMs <= 15_000;
    const second = await guardCall(ctx, ['arm', '3600'], budget);
    c['lifetime.secondArmRefused'] = second?.ok === false && second.failure === 'already_armed' && second.deadlineAt === armed?.deadlineAt;
    // The supervisor disappears: a detached exec client is killed and nothing else is sent.
    let client;
    const hung = base.docker.run(['exec', '--user', AGENT_USER, id, 'sleep', '600'], { timeoutMs: 120_000, onSpawn: (child) => { client = child; } });
    await new Promise((r) => setTimeout(r, 1000));
    client?.kill('SIGKILL');
    await hung;
    let state = null;
    const waitEnd = hostClock() + (armed?.remainingMs ?? 0) + 20_000;
    while (hostClock() < waitEnd) {
      state = await base.docker.json(['inspect', '--format', '{{json .State}}', id], { timeoutMs: 10_000 });
      if (state && state.Running === false) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    c['lifetime.stoppedWithoutHost'] = state?.Running === false && state.ExitCode === GUARD_EXIT_CODE;
  } finally {
    await base.resources.remove(id);
  }
}

/**
 * One qualification run directory inside the prepared run, with the supervised commands bound to it: its own lock held
 * through the production lock path, a synthetic credential file, a miniature project, and operation and inspection file
 * writers. Qualification-only driver calls (scripted prompt text, review comment seeding) go through `helper`.
 */
async function subRun(base, budget, notes, name, runSuffix) {
  const runId = `${base.runId}-${runSuffix}`;
  // The prepared run records its ownership of this qualification run before anything in it can create a resource.
  const sub = registerSubrun(base.journal, base.runDir, name, { runId, engineId: base.engineId });
  const xdg = join(sub, 'synthetic-auth');
  mkdirSync(join(xdg, 'opencode'), { recursive: true, mode: 0o700 });
  const authPath = join(xdg, 'opencode', 'auth.json');
  const synthetic = () => ({ openai: { type: 'oauth', access: `ic-synthetic-access-${randomBytes(24).toString('hex')}`, refresh: `ic-synthetic-refresh-${randomBytes(8).toString('hex')}`, expires: Date.now() + 3 * 3_600_000, accountId: `ic-synthetic-account-${randomBytes(6).toString('hex')}` } });
  writeFileSync(authPath, JSON.stringify(synthetic()), { mode: 0o600 });
  const snapshot = JSON.parse(readFileSync(join(base.runDir, 'inputs', 'snapshot.json'), 'utf8'));
  const request = {
    ...snapshot.request, model: { ref: snapshot.request.model.ref, variant: snapshot.request.model.variant }, initialPrimary: 'architect-planner',
    primaryTransitions: [{ from: 'architect-planner', to: 'swarm-orchestrator' }], dependencies: [], artifacts: ['src/', '.hive/features/'],
  };
  request.agentModels = { 'scout-researcher': { model: QUALIFICATION_MOCK_MODEL, variant: null } };
  writeOnce(join(sub, 'inputs', 'snapshot.json'), JSON.stringify({ ...snapshot, request, files: [], skills: {} }));
  const journal = new Journal(join(sub, 'records'));
  journal.write('input', { snapshotSha256: sha256File(join(sub, 'inputs', 'snapshot.json')), lockInode: String(lstatSync(join(sub, 'lock')).ino) });
  const prepared = journal.write('prepared', {
    schema: 'ic-exercise-prepared/v1', status: 'prepared', runId, host: base.host, request, docker: { endpoint: base.endpoint, engineId: base.engineId }, runtime: { imageId: base.imageId }, qualificationRun: true,
  });
  const env = { ...base.env, IC_EXERCISE_AUTH_PATH: authPath };
  const authFile = join(sub, 'authorization.json');
  writeFileSync(authFile, JSON.stringify({ schema: 'ic-exercise-authorization/v1', runId, preparedSha256: prepared.sha256, host: base.host, model: request.model, budgetSeconds: QUALIFICATION_BUDGET_SECONDS, allowedActions: ACTIONS, stopConditions: ['qualification complete'], authorizedBy: 'credential-free qualification' }));
  const lock = await acquireRunLock(join(sub, 'lock'));
  if (lock.busy) throw new HarnessError('qualification_lock_busy');
  const deps = { lock };
  // A bare controller context on the started container, for qualification's direct driver and guard calls.
  const control = () => {
    const ctx = openRun(sub, env, deadline(60_000));
    ctx.containerId = journal.read('start.container')?.value?.id;
    ctx.trusted = false;
    return ctx;
  };
  const helper = async (command, input) => {
    const ctx = control();
    const reply = await driver(ctx, command, input, deadline(30_000));
    if (!reply.value?.ok) throw new HarnessError(`qualification_${command}_failed`);
    return reply.value;
  };
  let opCount = 0;
  const operation = (action, fields) => {
    const file = join(sub, `operation-${++opCount}.json`);
    writeFileSync(file, JSON.stringify({ schema: 'ic-exercise-operation/v1', id: `q-${opCount}`, runId, sessionId: journal.read('start.session')?.value?.sessionId, action, ...fields }));
    return file;
  };
  const inspection = (fields) => {
    const file = join(sub, `inspection-${++opCount}.json`);
    writeFileSync(file, JSON.stringify({ schema: 'ic-exercise-inspection/v1', runId, ...fields }));
    return file;
  };
  const turn = (action, fields, extra = {}) => turnCommand({ run: sub, operation: operation(action, fields) }, env, extra, deps);
  const inspect = (fields) => inspectCommand({ run: sub, ...(fields ? { request: inspection(fields) } : {}) }, env, deps);
  const until = async (predicate, ms = 120_000, fields) => {
    const end = hostClock() + Math.min(ms, budget.left());
    let last = null;
    while (hostClock() < end) {
      last = await inspect(fields);
      if (predicate(last.status)) return last.status;
      await new Promise((r) => setTimeout(r, 2000));
    }
    notes.lastWait = { status: last?.status?.status ?? null, reasons: (last?.status?.reasons ?? []).slice(0, 8) };
    throw new HarnessError('qualification_wait_timeout');
  };
  const start = () => startCommand({ run: sub, authorization: authFile, budgetSeconds: QUALIFICATION_BUDGET_SECONDS }, env, {
    provider: 'mock', modelRef: QUALIFICATION_MOCK_MODEL, network: 'none', askExternalReads: true, qualification: true,
  }, deps);
  const finish = async () => {
    unlinkSync(authPath);
    const stopped = await stopCommand({ run: sub }, env, deps);
    lock.release();
    return stopped.status.status;
  };
  return { sub, journal, env, authPath, synthetic, lock, deps, helper, control, turn, inspect, until, start, finish, runId };
}

/**
 * How many of process `pid`'s open descriptors refer to the file `stat` describes, or null when they cannot be read.
 * Qualification uses it to show that a child of the acting process holds no descriptor of the run's lock.
 */
export function descriptorsOf(pid, stat) {
  let names;
  try { names = readdirSync(`/proc/${pid}/fd`); } catch { return null; }
  let count = 0;
  for (const name of names) {
    try {
      const target = statSync(`/proc/${pid}/fd/${name}`);
      if (target.dev === stat.dev && target.ino === stat.ino) count++;
    } catch { /* closed while reading */ }
  }
  return count;
}

/**
 * The whole supervised lifecycle on the installed host with the scripted mock model and a synthetic credential file:
 * start, question and reply, child permissions once and reject, refusals while not quiescent, plan read parity with the
 * candidate core, stale-plan refusal, lost acknowledgements (an approval, a primary switch, a question reply and a
 * permission reply) resolved only where the native API names the operation, revision-bound approval and sync made by
 * direct native calls, the caller's primary switch, completion, the shared clock, drivers past their command or effect
 * cutoff that send nothing, lock contention and descriptor ownership, auth rotation latching and
 * credential-independent stop. It runs in its own run directory inside the prepared run.
 */
async function qualifyProtocol(base, budget, notes, c) {
  const q = await subRun(base, budget, notes, 'qualification', 'q');
  const { sub, journal, env, authPath, synthetic, helper, turn, inspect, until } = q;
  const prompt = async (step, facts) => (await helper('qualification-prompt', { step, facts })).text;
  try {
    const started = await q.start();
    notes.start = { status: started.status.status, failures: started.status.failures };
    c['protocol.started'] = started.exit === EXIT.ok;
    if (!c['protocol.started']) return;
    const sessionId = started.status.sessionId;
    // The installed runtime's guard and driver read one clock: the driver's shared reading falls between two guard
    // readings. Its own process clock does not, which shows the bracket refuses a clock that starts per process.
    {
      const ctx = q.control();
      const before = await guardCall(ctx, ['status'], deadline(30_000));
      const reading = await driver(ctx, 'clock', {}, deadline(30_000));
      const after = await guardCall(ctx, ['status'], deadline(30_000));
      c['clock.sharedDomain'] = sharedClockBracket(before?.clockMs, reading.value?.clockMs, after?.clockMs);
      c['clock.processClockRefused'] = Number.isFinite(reading.value?.processMs) && !sharedClockBracket(before?.clockMs, reading.value.processMs, after?.clockMs);
      notes.clock = { guardBeforeMs: before?.clockMs ?? null, driverMs: reading.value?.clockMs ?? null, guardAfterMs: after?.clockMs ?? null, driverProcessMs: reading.value?.processMs ?? null };
    }
    const question = await until((s) => (s.pending ?? []).some((p) => p.kind === 'question'));
    const asked = question.pending.find((p) => p.kind === 'question');
    // The installed host's own description of the choice reaches the supervisor with its label, in a complete release.
    const choiceAt = asked.questions?.[0]?.options?.indexOf('alpha') ?? -1;
    c['protocol.questionPending'] = choiceAt >= 0 && asked.questions[0].optionDescriptions?.[choiceAt] === 'First marker' && asked.complete === true;
    c['protocol.promptRefusedWhileQuestionPending'] = (await turn('prompt', { text: 'not now' })).status.reason === 'not_quiescent';
    c['protocol.questionReplied'] = (await turn('reply', { requestId: asked.id, answers: [['alpha']] })).exit === EXIT.ok;
    for (const decision of ['once', 'reject']) {
      const pendingPermission = await until((s) => (s.pending ?? []).some((p) => p.kind === 'permission'));
      const p = pendingPermission.pending.find((x) => x.kind === 'permission');
      if (decision === 'once') {
        c['protocol.permissionPendingInChild'] = p.sessionId !== sessionId;
        c['protocol.promptRefusedWhileDescendantActive'] = (await turn('prompt', { text: 'not now' })).status.reason === 'not_quiescent';
      }
      c[decision === 'once' ? 'protocol.permissionOnce' : 'protocol.permissionReject'] = (await turn('permission', { requestId: p.id, decision })).exit === EXIT.ok;
    }
    const planned = await until((s) => s.quiescent === true, 120_000, { conversation: {}, plan: { feature: 'exercise-qualification' } });
    const evidence = JSON.parse(readFileSync(planned.evidence, 'utf8'));
    const children = evidence.conversation.sessions.filter((s) => s.parentId === sessionId);
    c['protocol.childReturned'] = children.some((s) => s.agent === 'scout-researcher' && s.finalReturn?.text?.includes('QUALIFICATION-CHILD-RETURN'));
    const primaryTurns = evidence.conversation.sessions.find((s) => s.id === sessionId)?.turns ?? [];
    c['protocol.sameSessionMultiTurn'] = primaryTurns.some((t) => t.tools.some((x) => x.name === 'question' && x.status === 'completed' && x.answers?.text?.includes('alpha')));
    c['protocol.planParity'] = planned.plan?.ok === true && planned.plan.pluginRead?.differences?.length === 0;
    // The read the supervisor's decision rests on is a direct native hive_plan_read part of the primary, by call ID.
    c['protocol.directPlanRead'] = typeof planned.plan?.pluginRead?.callId === 'string'
      && primaryTurns.some((t) => t.tools.some((x) => x.name === 'hive_plan_read' && x.id === planned.plan.pluginRead.callId));
    const firstRevision = planned.plan?.revision;
    // A VS Code style review comment changes the revision; an approval of the old revision is refused before sending.
    const seeded = await helper('seed-comments', { feature: 'exercise-qualification' });
    const stale = await turn('approve-plan', { project: PROJECT_ROOT, feature: 'exercise-qualification', revision: firstRevision, contentHash: planned.plan.contentHash, permittedWork: 'qualification marker' });
    c['protocol.stalePlanRefused'] = seeded.revision !== firstRevision && stale.status.reason === 'plan_changed';
    // The primary reads the commented plan through the plugin; both readers must agree, comments included.
    await turn('prompt', { text: await prompt('reread') });
    const commented = await until((s) => s.quiescent === true && s.plan?.pluginRead?.revision === seeded.revision, 120_000, { plan: { feature: 'exercise-qualification' } });
    const withComments = JSON.parse(readFileSync(commented.evidence, 'utf8')).plan;
    c['protocol.commentParity'] = withComments?.ok === true && withComments.comments?.text?.includes('qualification-comment') === true && commented.plan.pluginRead.differences.length === 0;
    // Rewriting the plan unchanged clears the comments through a real plugin operation, giving the revision to approve.
    await turn('prompt', { text: await prompt('rewrite') });
    const reread = await until((s) => s.quiescent === true && s.plan?.pluginRead && s.plan.pluginRead.revision !== seeded.revision && s.plan.pluginRead.differences.length === 0, 120_000, { plan: { feature: 'exercise-qualification' } });
    const revision = reread.plan.revision;
    c['protocol.switchRequiresApproval'] = (await turn('switch-primary', { to: 'swarm-orchestrator' })).status.reason === 'approval_not_observed';
    const approvalScript = await prompt('approve', { revision });
    const lost = await turn('approve-plan', { project: PROJECT_ROOT, feature: 'exercise-qualification', revision, contentHash: reread.plan.contentHash, permittedWork: 'write the qualification marker' }, { dropAcknowledgement: true, approvalScript: () => approvalScript });
    const lostId = lost.status.operation;
    c['protocol.approvalAckLost'] = lost.exit === EXIT.busy && lost.status.state === 'unknown';
    c['protocol.noReplayWhileUnknown'] = (await turn('prompt', { text: 'again' })).status.reason === 'operation_unresolved';
    const resolved = await inspect({ resolve: lostId });
    c['protocol.resolvedByExactId'] = resolved.status.resolution?.resolved === true && resolved.status.resolution.effect === 'accepted';
    const approved = await until((s) => s.quiescent === true && s.plan?.status === 'approved', 120_000, { conversation: {}, plan: { feature: 'exercise-qualification' } });
    const approvedEvidence = JSON.parse(readFileSync(approved.evidence, 'utf8'));
    const approvals = approvedEvidence.approvals ?? [];
    const bound = approvals.filter((a) => a.sessionId === sessionId && a.expectedRevision === revision && a.approvalSuccess && a.syncSuccess);
    c['protocol.revisionBoundApproval'] = bound.length > 0;
    // That approval is a direct native hive_plan_approve part of the primary, by call ID.
    const approvedTurns = approvedEvidence.conversation.sessions.find((s) => s.id === sessionId)?.turns ?? [];
    c['protocol.directApproval'] = bound.some((a) => typeof a.callId === 'string' && approvedTurns.some((t) => t.tools.some((x) => x.name === 'hive_plan_approve' && x.id === a.callId)));
    c['protocol.approvedParity'] = approved.plan.pluginRead?.differences?.length === 0;
    // The switch is sent with its acknowledgement lost. v2 switches the session natively, so the loss is unknown until
    // the session's own agent shows the target; v1 has no session agent and acknowledges the checked switch locally.
    const switched = await turn('switch-primary', { to: 'swarm-orchestrator' }, { dropAcknowledgement: true });
    if (base.host === 'v2') {
      const switchId = switched.status.operation;
      const settled = switched.status.state === 'unknown' && (await turn('prompt', { text: 'again' })).status.reason === 'operation_unresolved'
        && (await inspect({ resolve: switchId })).status.resolution?.resolved === true;
      c['protocol.switchAckLostSafe'] = settled;
    } else c['protocol.switchAckLostSafe'] = switched.exit === EXIT.ok && switched.status.local === true;
    c['protocol.primarySwitched'] = runState(journal).primary === 'swarm-orchestrator';
    await turn('prompt', { text: await prompt('execute') });
    const done = await until((s) => s.quiescent === true, 120_000, { conversation: {}, artifacts: ['src/qualified.txt'] });
    const final = JSON.parse(readFileSync(done.evidence, 'utf8'));
    const lastAssistant = final.conversation.sessions.find((s) => s.id === sessionId)?.turns.filter((t) => t.role === 'assistant').at(-1);
    c['protocol.completed'] = lastAssistant?.text?.includes('QUALIFICATION-COMPLETE') && lastAssistant.agent === 'swarm-orchestrator' && final.artifacts?.[0]?.text === 'qualified\n';

    // Two prompts the driver must not send, each checked afterwards by its message ID in the native session. The first
    // driver starts after its command cutoff and does nothing at all. The second starts inside its command cutoff with
    // the effect cutoff already behind it: it observes the session (its refusal carries the observation's reasons) and
    // refuses at the request.
    {
      const ctx = q.control();
      const model = journal.read('start.session').value.model;
      const prompt = (messageId) => ({ sessionId, op: { kind: 'prompt', sessionId, messageId, agent: 'swarm-orchestrator', model, text: 'cutoff prompt', plan: null } });
      const absent = async (messageId) => (await driver(ctx, 'observe', { sessionId, resolve: { kind: 'prompt', sessionId, messageId } }, deadline(30_000))).value?.resolution?.resolved === false;
      const lateMessage = exerciseMessageId(Date.now(), 9000);
      const late = await driver(ctx, 'submit', prompt(lateMessage), { end: hostClock() - 5000, left: () => 30_000 });
      c['protocol.lateDriverSendsNothing'] = late.value?.ok === false && late.value.failure === 'deadline_exceeded' && late.value.submitted === false && await absent(lateMessage);
      const status = await guardCall(ctx, ['status'], deadline(30_000));
      const cutoffMessage = exerciseMessageId(Date.now(), 9001);
      const cut = await driver(ctx, 'submit', prompt(cutoffMessage), deadline(30_000), { reserveMs: (status?.remainingMs ?? 0) + 1_000 });
      c['protocol.actionCutoffSendsNothing'] = cut.value?.ok === true && cut.value.submitted === false && cut.value.refused === 'deadline_exceeded' && Array.isArray(cut.value.reasons)
        && await absent(cutoffMessage);
    }

    // A question reply with its acknowledgement lost: unknown, never replayed, resolved only by the answers the exact tool call (v1) or form (v2) recorded.
    await turn('prompt', { text: await prompt('faultQuestion') });
    const faultQuestion = await until((s) => (s.pending ?? []).some((p) => p.kind === 'question'));
    const fq = faultQuestion.pending.find((p) => p.kind === 'question');
    const lostReply = await turn('reply', { requestId: fq.id, answers: [['gamma']] }, { dropAcknowledgement: true });
    c['protocol.replyAckLost'] = lostReply.exit === EXIT.busy && lostReply.status.state === 'unknown';
    c['protocol.replyNoReplay'] = (await turn('reply', { requestId: fq.id, answers: [['delta']] })).status.reason === 'operation_unresolved';
    const replyResolved = await until((s) => s.resolution?.resolved === true, 60_000, { resolve: lostReply.status.operation });
    c['protocol.replyResolvedByAnswers'] = replyResolved.resolution.effect === 'accepted';
    await until((s) => s.quiescent === true);

    // A permission reply with its acknowledgement lost: the native API names no operation for it, so it stays unknown.
    await turn('prompt', { text: await prompt('faultPermission') });
    const faultPermission = await until((s) => (s.pending ?? []).some((p) => p.kind === 'permission'));
    const fp = faultPermission.pending.find((p) => p.kind === 'permission');
    const lostPermission = await turn('permission', { requestId: fp.id, decision: 'reject' }, { dropAcknowledgement: true });
    c['protocol.permissionAckLost'] = lostPermission.exit === EXIT.busy && lostPermission.status.state === 'unknown';
    await new Promise((r) => setTimeout(r, 5000));
    const stillUnknown = await inspect({ resolve: lostPermission.status.operation });
    c['protocol.permissionStaysUnknown'] = stillUnknown.status.resolution?.resolved === false && runState(journal).unresolved.includes(lostPermission.status.operation);

    // The run's lock is held through this process's own descriptor long after its flock helper exited, and a child of
    // this process holds no descriptor of the lock file. The CLI of the held run reports busy.
    const lockFile = statSync(join(sub, 'lock'));
    const bystander = spawn('sleep', ['30'], { stdio: 'ignore' });
    const probe = spawnSync('flock', ['--nonblock', '--conflict-exit-code', String(LOCK_BUSY), join(sub, 'lock'), 'true']);
    c['protocol.lockSurvivesNoDescendant'] = probe.status === LOCK_BUSY && descriptorsOf(process.pid, lockFile) === 1 && descriptorsOf(bystander.pid, lockFile) === 0;
    bystander.kill('SIGKILL');
    const successor = spawnSync(process.execPath, [SCRIPT, 'inspect', '--run', sub], { encoding: 'utf8', env });
    c['protocol.lockBusy'] = lastJsonLine(successor.stdout)?.status === 'busy';
    // Host auth rotation: the next command latches; the replacement token is never adopted for scanning.
    writeFileSync(authPath, JSON.stringify(synthetic()), { mode: 0o600 });
    const rotated = await inspect({ conversation: {} });
    c['protocol.rotationLatched'] = rotated.status.status === 'content_unavailable' && rotated.status.reason === 'host_auth_changed' && !('pending' in rotated.status);
    const latched = await inspect({ conversation: {} });
    c['protocol.latchedInspectWithoutContent'] = latched.status.status === 'content_unavailable' && !('pending' in latched.status) && !('evidence' in latched.status);
  } finally {
    const status = await q.finish();
    c['protocol.cleanupWithoutAuth'] = status === 'cleanup_confirmed';
    notes.stop = status;
  }
}

/**
 * An interrupt whose acknowledgement is lost, on a session held busy by an open question: unknown, not replayed, and
 * not resolved by what the session looks like afterwards, because the native API names no interrupt.
 */
async function qualifyInterruptLoss(base, budget, notes, c) {
  const q = await subRun(base, budget, notes, 'qualification-interrupt', 'qi');
  try {
    const started = await q.start();
    c['interrupt.started'] = started.exit === EXIT.ok;
    if (!c['interrupt.started']) return;
    await q.until((s) => (s.pending ?? []).some((p) => p.kind === 'question'));
    const lost = await q.turn('interrupt', {}, { dropAcknowledgement: true });
    c['interrupt.ackLost'] = lost.exit === EXIT.busy && lost.status.state === 'unknown';
    c['interrupt.noReplay'] = (await q.turn('interrupt', {})).status.reason === 'operation_unresolved';
    await new Promise((r) => setTimeout(r, 5000));
    const observed = await q.inspect({ resolve: lost.status.operation });
    c['interrupt.staysUnknown'] = observed.status.resolution?.resolved === false && runState(q.journal).unresolved.includes(lost.status.operation);
  } finally {
    const status = await q.finish();
    c['interrupt.cleanupWithoutAuth'] = status === 'cleanup_confirmed';
  }
}

// -----------------------------------------------------------------------------------------------------------------
// Entry

export async function main(argv, { env = process.env, stdout = process.stdout, lockWaitSeconds = LOCK_WAIT_SECONDS } = {}) {
  const startedAt = hostClock();
  let parsed;
  try {
    parsed = parseExerciseCli(argv);
  } catch (error) {
    stdout.write(JSON.stringify({ status: 'invalid', failure: error instanceof HarnessError ? error.code : 'arguments_invalid' }) + '\n');
    return EXIT.invalid;
  }
  if (parsed.command === 'help') {
    stdout.write(USAGE[parsed.topic] + '\n');
    return EXIT.ok;
  }
  const { command, options } = parsed;
  const say = (status) => stdout.write(JSON.stringify(status) + '\n');
  // Every command except prepare acts under the run's kernel lock, held through this process's own descriptor until the
  // command has finished.
  let lock = null;
  if (command !== 'prepare') {
    const lockPath = join(options.run, 'lock');
    if (!existsSync(lockPath)) { say({ command, status: 'refused', reason: 'run_not_prepared' }); return EXIT.invalid; }
    if (!flockAvailable()) { say({ command, status: 'refused', reason: 'lock_prerequisite_missing' }); return EXIT.failed; }
    try {
      lock = await acquireRunLock(lockPath, { waitSeconds: lockWaitSeconds });
    } catch (error) {
      say({ command, status: 'refused', reason: error instanceof HarnessError ? error.code : 'lock_acquire_failed' });
      return EXIT.failed;
    }
    if (lock.busy) { say({ command, status: 'busy', reason: 'lock_busy' }); return EXIT.busy; }
  }
  const deps = { lock, startedAt };
  try {
    const result = await {
      prepare: () => prepareCommand(options, env),
      start: () => startCommand(options, env, {}, deps),
      turn: () => turnCommand(options, env, {}, deps),
      inspect: () => inspectCommand(options, env, deps),
      stop: () => stopCommand(options, env, deps),
    }[command]();
    say(result.status);
    return result.exit;
  } catch (error) {
    const code = error instanceof HarnessError || error instanceof CredentialError ? error.code : 'unexpected_exception';
    say({ command, status: error instanceof ExerciseRefusal ? 'refused' : 'failed', failure: code });
    return error instanceof HarnessError && /_invalid$|_mismatch$|not_authorized|_contaminated$/.test(code) ? EXIT.invalid : EXIT.failed;
  } finally {
    lock?.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  main(process.argv.slice(2)).then((code) => process.exit(code), () => {
    process.stdout.write(JSON.stringify({ status: 'failed', failure: 'unexpected_exception' }) + '\n');
    process.exit(EXIT.failed);
  });
}
